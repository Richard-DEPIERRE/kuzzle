/*
 * Kuzzle, a backend software, self-hostable and ready to use
 * to power modern apps
 *
 * Copyright 2015-2020 Kuzzle
 * mailto: support AT kuzzle.io
 * website: http://kuzzle.io
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const assert = require('assert');
const url = require('url');
const zlib = require('zlib');

const uWS = require('uWebSockets.js');

const { Request } = require('../../../api/request');
const { KuzzleError } = require('../../../kerror/errors');
const Protocol = require('./protocol');
const ClientConnection = require('../clientConnection');
const removeErrorStack = require('../removeErrorStack');
const bytes = require('../../../util/bytes');
const debug = require('../../../util/debug');
const kerror = require('../../../kerror');

const kerrorWS = kerror.wrap('network', 'websocket');
const kerrorHTTP = kerror.wrap('network', 'http');
const debugWS = debug('kuzzle:network:protocols:websocket');
const debugHTTP = debug('kuzzle:network:protocols:http');

// The idleTimeout option should never be deactivated, so instead we use
// a default value for backward-compatibility
const DEFAULT_IDLE_TIMEOUT = 60000;

// Size of backpressure an individual socket can handle before needing to drain
const WS_MAX_BACKPRESSURE = 4096;

// Size of the backpressure buffer: if a client is too slow to absorb the amount
// of data we need to send to it, then we forcibly close its socket to prevent
// the server to be impacted by it
const WS_BACKPRESSURE_BUFFER_MAX_LENGTH = 50;

// Applicative WebSocket PONG message for browsers
const APPLICATIVE_PONG_MESSAGE = Buffer.from('{"p":2}');

// Used by the broadcast method to build JSON payloads while limiting the
// number of JSON serializations
const JSON_ROOM_PROPERTY = ',"room":"';
const JSON_ENDER = '"}';

// pre-computed error messages
const TOO_MUCH_BACKPRESSURE_MESSAGE = Buffer.from('too much backpressure: client is too slow');
const GENERIC_CLOSE_MESSAGE = Buffer.from('Connection closed by remote host');

// HTTP-related constants
const ALLOWED_JSON_CONTENT_TYPES = [
  'application/json',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
];

const HTTP_HEADER_CONTENT_LENGTH = Buffer.from('Content-Length');

const HTTP_REQUEST_TOO_LARGE_ERROR = kerrorHTTP.get('request_too_large');
const CHARSET_REGEX = /charset=([\w-]+)/i;


/**
 * @class HttpMessage
 */
class HttpMessage {
  /**
   * @param {ClientConnection} connection
   * @param {uWS.HttpRequest} request
   */
  constructor(connection, request) {
    this.connection = connection;
    this._content = null;
    this.ips = connection.ips;
    this.requestId = connection.id;
    // @deprecated use "path" instead
    this.url = request.getUrl() + '?' + request.getQuery();
    this.path = this.url;
    this.method = request.getMethod().toUpperCase();
    this.headers = {};

    request.forEach((name, value) => (this.headers[name] = value));
  }

  /**
   * Checks that an incoming HTTP message is well-formed
   *
   */
  validate () {
    const contentType = this.headers['content-type'];

    if ( contentType
      && !ALLOWED_JSON_CONTENT_TYPES.some(allowed => contentType.includes(allowed))
    ) {
      throw kerrorHTTP.get('unsupported_content', contentType);
    }

    const encoding = CHARSET_REGEX.exec(contentType);

    if (encoding !== null && encoding[1].toLowerCase() !== 'utf-8') {
      throw kerrorHTTP.get('unsupported_charset', encoding[1].toLowerCase());
    }
  }

  set content (value) {
    if (!value && value.length === 0) {
      this._content = null;
    }
    else {
      this.validate();
      this._content = value;
    }
  }

  get content () {
    return this._content;
  }
}

/**
 * @class HTTPWS
 * Handles both HTTP and WebSocket connections
 */
class HTTPWS extends Protocol {
  constructor () {
    super('websocket');

    this.server = null;
    this.wsConfig = null;
    this.httpConfig = null;

    // Used to limit the rate of messages on websocket
    this.now = Date.now();
    this.nowInterval = setInterval(() => {
      this.activityTimestamp = Date.now();
    }, 1000);

    // Map<uWS.WebSocket, ClientConnection>
    this.connectionBySocket = new Map();

    // Map<uWS.WebSocket, Array.<Buffer>>
    this.backpressureBuffer = new Map();

    // Map<string, uWS.WebSocket>
    this.socketByConnectionId = new Map();
  }

  async init (entrypoint) {
    super.init(null, entrypoint);

    this.config = entrypoint.config.protocols;

    this.wsConfig = this.parseWebSocketOptions();
    this.httpConfig = this.parseHttpOptions();

    if (!this.wsConfig.enabled && !this.httpConfig.enabled) {
      return false;
    }

    // eslint-disable-next-line new-cap
    this.server = uWS.App();

    if (this.wsConfig.enabled) {
      this.initWebSocket();
    }

    if (this.httpConfig.enabled) {
      this.initHttp();
    }

    this.server.listen(entrypoint.config.port, socket => {
      if (!socket) {
        throw new Error(`[http/websocket] fatal: unable to listen to port ${entrypoint.config.port}`);
      }
    });

    return true;
  }

  initWebSocket () {
    /* eslint-disable sort-keys */
    this.server.ws('/*', {
      ...this.wsConfig.opts,
      maxBackPressure: WS_MAX_BACKPRESSURE,
      open: this.wsOnOpenHandler.bind(this),
      close: this.wsOnCloseHandler.bind(this),
      message: this.wsOnMessageHandler.bind(this),
      drain: this.wsOnDrainHandler.bind(this),
    });
    /* eslint-enable sort-keys */
  }

  initHttp () {
    this.server.any('/*', this.httpOnMessageHandler.bind(this));
  }

  broadcast (data) {
    const stringified = JSON.stringify(data.payload);
    const payloadByteSize = Buffer.from(stringified).byteLength;
    // 255 bytes should be enough to hold the following:
    //     ,"room":"<channel identifier>"
    // (with current channel encoding, this is less than 100 bytes)
    const payload = Buffer.allocUnsafe(payloadByteSize + 255);

    let offset = payloadByteSize - 1;

    payload.write(stringified, 0);
    payload.write(JSON_ROOM_PROPERTY, offset);

    offset += JSON_ROOM_PROPERTY.length;

    for (const channel of data.channels) {
      // Adds the room property to the message
      payload.write(channel, offset);
      payload.write(JSON_ENDER, offset + channel.length);

      // prevent buffer overwrites due to socket.send being an
      // async method (race condition)
      const payloadLength = offset + channel.length + JSON_ENDER.length;
      const payloadSafeCopy = Buffer.allocUnsafe(payloadLength);

      payload.copy(payloadSafeCopy, 0, 0, payloadLength);

      debugWS('Publishing to channel "realtime/%s": %s', channel, payloadSafeCopy);
      this.server.publish(`realtime/${channel}`, payloadSafeCopy, false);
    }
  }

  notify (data) {
    const socket = this.socketByConnectionId.get(data.connectionId);
    debugWS('notify: %a', data);

    if (!socket) {
      return;
    }

    const payload = data.payload;


    for (let i = 0; i < data.channels.length; i++) {
      payload.room = data.channels[i];
      this.wsSend(socket, Buffer.from(JSON.stringify(payload)));
    }
  }

  joinChannel (channel, connectionId) {
    debugWS('joinChannel: %s %s', channel, connectionId);

    const socket = this.socketByConnectionId.get(connectionId);

    if (!socket) {
      return;
    }

    debugWS('Subscribing connection ID "%s" to channel "realtime/%s"', connectionId, channel);
    socket.subscribe(`realtime/${channel}`);
  }

  leaveChannel (channel, connectionId) {
    debugWS('leaveChannel: %s %s', channel, connectionId);

    const socket = this.socketByConnectionId.get(connectionId);

    if (!socket) {
      return;
    }

    socket.unsubscribe(`realtime/${channel}`);
  }

  disconnect (connectionId, message = null) {
    debug('[%s] forced disconnect', connectionId);

    const socket = this.socketByConnectionId.get(connectionId);

    if (!socket) {
      return;
    }

    socket.end(1011, message ? Buffer.from(message) : GENERIC_CLOSE_MESSAGE);
  }

  wsOnOpenHandler (socket) {
    const ip = Buffer.from(socket.getRemoteAddressAsText()).toString();
    const connection = new ClientConnection(this.name, [ip]);

    this.entryPoint.newConnection(connection);
    this.connectionBySocket.set(socket, connection);
    this.socketByConnectionId.set(connection.id, socket);
    this.backpressureBuffer.set(socket, []);
  }

  wsOnCloseHandler (socket, code, message) {
    const connection = this.connectionBySocket.get(socket);

    if (!connection) {
      return;
    }

    if (debugWS.enabled) {
      debugWS(
        '[%s] received a `close` event (CODE: %d, REASON: %s)',
        connection.id,
        code,
        Buffer.from(message).toString());
    }
    this.entryPoint.removeConnection(connection.id);
    this.connectionBySocket.delete(socket);
    this.backpressureBuffer.delete(socket);
    this.socketByConnectionId.delete(connection.id);
  }

  wsOnMessageHandler (socket, data) {
    const connection = this.connectionBySocket.get(socket);

    if (!data || !connection) {
      return;
    }

    // enforce rate limits
    if (this.wsConfig.rateLimit > 0) {
      if (socket.last === this.now) {
        socket.count++;

        if (socket.count > this.wsConfig.rateLimit) {
          this.wsSendError(socket, connection, kerrorWS.get('ratelimit_exceeded'));
          return;
        }
      }
      else {
        socket.last = this.now;
        socket.count = 1;
      }
    }

    let parsed;
    const message = Buffer.from(data).toString();

    debugWS('[%s] client message: %s', connection.id, message);

    try {
      parsed = JSON.parse(message);
    }
    catch (e) {
      /*
       we cannot add a "room" information since we need to extract
       a request ID from the incoming data, which is apparently
       not a valid JSON
       So... the error is forwarded to the client, hoping they know
       what to do with it.
       */
      this.wsSendError(
        socket,
        connection,
        kerrorWS.getFrom(e, 'unexpected_error', e.message));
      return;
    }

    if (parsed.p && parsed.p === 1 && Object.keys(parsed).length === 1) {
      debugWS('[%s] sending back a "pong" message', connection.id);
      this.wsSend(socket, APPLICATIVE_PONG_MESSAGE);
      return;
    }

    try {
      this.entryPoint.execute(new Request(parsed, { connection }), result => {
        if (result.content && typeof result.content === 'object') {
          result.content.room = result.requestId;
        }
        this.wsSend(socket, Buffer.from(JSON.stringify(result.content)));
      });
    }
    catch (e) {
      const errobj = {
        error: {
          message: e.message
        },
        room: parsed.requestId,
        status: 400
      };

      this.wsSend(socket, Buffer.from(JSON.stringify(errobj)));
    }
  }

  /**
   * Absorb as much of the backpressure buffer as possible
   * @param  {uWS.WebSocket} socket
   */
  wsOnDrainHandler (socket) {
    socket.cork(() => {
      const buffer = this.backpressureBuffer.get(socket);

      while (buffer.length > 0
        && socket.getBufferedAmount() < WS_MAX_BACKPRESSURE
      ) {
        const payload = buffer.shift();
        socket.send(payload);
      }
    });
  }

  /**
   * Forwards an error to a socket
   *
   * @param  {uWS.WebSocket} socket
   * @param  {ClientConnection} connection
   * @param  {Error} error
   */
  wsSendError (socket, connection, error) {
    const request = new Request({}, { connection, error });
    const sanitized = removeErrorStack(request.response.toJSON()).content;

    this.wsSend(socket, Buffer.from(JSON.stringify(sanitized)));
  }

  /**
   * Sends a message immediately, or queue it up for later if backpressure built
   * up
   *
   * @param  {uWS.WebSocket} socket
   * @param  {Buffer} payload
   */
  wsSend (socket, payload) {
    if (!this.connectionBySocket.has(socket)) {
      return;
    }

    if (socket.getBufferedAmount() < WS_MAX_BACKPRESSURE) {
      socket.cork(() => socket.send(payload));
    }
    else {
      const buffer = this.backpressureBuffer.get(socket);
      buffer.push(payload);

      // Client socket too slow: we need to close it
      if (buffer.length > WS_BACKPRESSURE_BUFFER_MAX_LENGTH) {
        socket.end(1011, TOO_MUCH_BACKPRESSURE_MESSAGE);
      }
    }
  }

  /**
   * @param  {uWS.HttpResponse} response
   * @param  {uWS.HttpRequest} request
   */
  httpOnMessageHandler (response, request) {
    const connection = new ClientConnection(
      'HTTP/1.1',
      getHttpIps(response, request),
      request.headers);
    const message = new HttpMessage(connection, request);

    debugHTTP('[%s] Received HTTP request: %a', connection.id, message);

    if (message.headers['content-length'] > this.maxRequestSize) {
      this.httpSendError(message, response, HTTP_REQUEST_TOO_LARGE_ERROR);
      return;
    }

    this.httpReadData(message, response, (err) => {
      if (err) {
        this.httpSendError(message, response, err);
        return;
      }

      this.httpProcessRequest(connection, response, message);
    });

  }

  /**
   * Read an HTTP payload data
   *
   * @param  {HttpMessage} message
   * @param  {uWS.HttpResponse} response
   * @param  {Function} cb
   */
  httpReadData (message, response, cb) {
    let payload;

    response.onData((data, isLast) => {
      if (!data || data.byteLength === 0) {
        cb();
        return;
      }

      const chunk = Buffer.from(data);
      payload = payload ? Buffer.concat([payload, chunk]) : chunk;

      /*
       * The content-length header can be bypassed and
       * is not reliable enough. We have to enforce the HTTP
       * max size limit while reading chunks too
       */
      if (payload.length > this.maxRequestSize) {
        cb(HTTP_REQUEST_TOO_LARGE_ERROR);
        return;
      }

      if (!isLast) {
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(this.httpUncompress(message, payload));
      }
      catch (e) {
        cb(kerrorHTTP.getFrom(e, 'unexpected_error', e.message));
        return;
      }

      try {
        message.content = parsed;
      }
      catch (e) {
        cb(e);
        return;
      }

      cb();
    });

    // We don't care if a request aborts, let it die
    response.onAborted(() => {});
  }

  httpProcessRequest (connection, response, message) {
    debugHTTP('[%s] httpProcessRequest: %a', connection.id, message);

    this.entryPoint.newConnection(connection);

    global.kuzzle.router.http.route(message, request => {
      this.entryPoint.logAccess(request, message);
      this.entryPoint.removeConnection(connection.id);

      const data = this.httpRequestToResponse(request, message);

      this.httpCompress(message, data, (err, result) => {
        if (err) {
          const kuzerr = err instanceof KuzzleError
            ? err
            : kerror.getFrom(err, 'unexpected_error', err.message);

          this.httpSendError(connection, response, kuzerr);
          return;
        }

        request.response.setHeader('Content-Encoding', result.encoding);
        request.response.setHeader('Content-Length', result.compressed.length);

        response.cork(() => {
          response.writeStatus(Buffer.from(request.response.status.toString()));

          for (const [key, value] of Object.entries(request.response.headers)) {
            response.writeHeader(Buffer.from(key), Buffer.from(value.toString()));
          }

          const [ success ] = response.tryEnd(
            result.compressed,
            result.compressed.length);

          if (!success) {
            response.onWritable(offset => {
              const retryData = result.compressed.subarray(offset);
              const [ retrySuccess ] = response.tryEnd(
                retryData,
                retryData.length);

              return retrySuccess;
            });
          }
        });
      });
    });
  }

  /**
   * Forward an error response to the client
   *
   * @param {HttpMessage} message
   * @param {uWS.HttpResponse} response
   * @param {Error} error
   */
  httpSendError (message, response, error) {
    const kerr = error instanceof KuzzleError
      ? error
      : kerrorHTTP.getFrom(error, 'unexpected_error', error.message);

    const content = Buffer.from(JSON.stringify(removeErrorStack(kerr)));

    debugHTTP('[%s] httpSendError: %a', message.connection.id, kerr);

    this.entryPoint.logAccess(
      new Request(message, {
        connectionId: message.connection.id,
        error: kerr,
      }),
      message);

    response.cork(() => {
      response.writeStatus(Buffer.from(kerr.status.toString()));

      for (const header of this.httpConfig.headers) {
        response.writeHeader(header[0], header[1]);
      }

      response.writeHeader(
        HTTP_HEADER_CONTENT_LENGTH,
        Buffer.from(content.length.toString()));

      response.end(content);
    });

    this.entryPoint.removeConnection(message.connection.id);
  }

  /**
   * Convert a Kuzzle query result into an appropriate payload format
   * to send back to the client
   *
   * @param {Request} request
   * @param {HttpMessage} message
   * @returns {Buffer}
   */
  httpRequestToResponse(request, message) {
    let data = removeErrorStack(request.response.toJSON());

    if (message.requestId !== data.requestId) {
      data.requestId = message.requestId;

      if (!data.raw) {
        data.content.requestId = message.requestId;
      }
    }

    debugHTTP('HTTP request response: %a', data);

    if (data.raw) {
      if (data.content === null || data.content === undefined) {
        data = '';
      }
      else if (typeof data.content === 'object') {
        /*
         This object can be either a Buffer object, a stringified Buffer object,
         or anything else.
         In the former two cases, we create a new Buffer object, and in the
         latter, we stringify t he content.
         */
        if ( data.content instanceof Buffer
          || (data.content.type === 'Buffer' && Array.isArray(data.content.data))
        ) {
          data = data.content;
        }
        else {
          data = JSON.stringify(data.content);
        }
      }
      else {
        // scalars are sent as-is
        data = data.content;
      }
    }
    else {
      let indent = 0;
      const parsedUrl = url.parse(message.url, true);

      if (parsedUrl.query && parsedUrl.query.pretty !== undefined) {
        indent = 2;
      }

      data = JSON.stringify(data.content, undefined, indent);
    }

    return Buffer.from(data);
  }

  /**
   * Compress an outgoing message according to the
   * specified accept-encoding HTTP header
   *
   * @param  {HttpMessage} message
   * @param  {Buffer} data
   * @param  {Function} callback
   */
  httpCompress(message, data, callback) {
    if (message.headers['accept-encoding']) {
      let encodings = message.headers['accept-encoding']
        .split(',')
        .map(e => e.trim().toLowerCase());

      // gzip should be preferred over deflate
      if (encodings.has('gzip')) {
        zlib.gzip(data, (err, compressed) => callback(err, err ? null : {
          compressed,
          encoding: 'gzip',
        }));
        return;
      }
      else if (encodings.has('deflate')) {
        zlib.deflate(data, (err, compressed) => callback(err, err ? null : {
          compressed,
          encoding: 'deflate',
        }));
        return;
      }
    }

    callback(null, {
      compressed: data,
      encoding: 'identity',
    });
  }

  /**
   * Return a new Readable Stream configured with
   * uncompression algorithms if needed
   *
   * @param  {HttpMessage} request
   * @returns {Array.<stream.Readable>}
   * @throws {BadRequestError} If invalid compression algorithm is set
   *                           or if the value does not comply to the
   *                           way the Kuzzle server is configured
   */
  httpUncompress (message, payload) {
    return payload.toString();
  }

  parseWebSocketOptions () {
    const cfg = this.config.websocket;

    if (cfg === undefined) {
      global.kuzzle.log.warn('[websocket] no configuration found for websocket: disabling it');
      return { enabled: false };
    }

    assert(typeof cfg.enabled === 'boolean', `[websocket] "enabled" parameter: invalid value "${cfg.enabled}" (boolean expected)`);
    assert(Number.isInteger(cfg.idleTimeout) && cfg.idleTimeout >= 0, `[websocket] "idleTimeout" parameter: invalid value "${cfg.idleTimout}" (integer >= 1000 expected)`);
    assert(Number.isInteger(cfg.rateLimit) && cfg.rateLimit >= 0, `[websocket] "rateLimit" parameter: invalid value "${cfg.rateLimit}" (integer >= 0 expected)`);
    assert(typeof cfg.compression === 'boolean', `[websocket] "compression" parameter: invalid value "${cfg.compression}" (boolean value expected)`);

    let idleTimeout = cfg.idleTimeout;
    const compression = cfg.compression ? uWS.SHARED_COMPRESSOR : uWS.DISABLED;

    if (idleTimeout === 0 || idleTimeout < 1000) {
      idleTimeout = DEFAULT_IDLE_TIMEOUT;
      global.kuzzle.log.warn(`[websocket] The "idleTimeout" parameter cannot be deactivated or be set with a value lower than 1000. Defaulted to ${DEFAULT_IDLE_TIMEOUT}.`);
    }

    if (this.config.websocket.heartbeat) {
      global.kuzzle.log.warn('[websocket] The "heartbeat" parameter has been deprecated and is now ignored. The "idleTimeout" parameter should now be configured instead.');
    }

    return {
      enabled: cfg.enabled,
      opts: {
        compression,
        idleTimeout,
        maxPayloadLength: this.maxRequestSize,
      },
      rateLimit: cfg.rateLimit,
    };
  }

  parseHttpOptions () {
    const cfg = this.config.http;

    assert(typeof cfg.enabled === 'boolean', `[http] "enabled" parameter: invalid value "${cfg.enabled}" (boolean expected)`);
    assert(typeof cfg.allowCompression === 'boolean', `[http] "allowCompression" parameter: invalid value "${cfg.allowCompression}" (boolean expected)`);
    assert(Number.isInteger(cfg.maxEncodingLayers) && cfg.maxEncodingLayers >= 1, `[http] "maxEncodingLayers" parameter: cannot parse "${cfg.maxEncodingLayers} (integer >= 1 expected)"`);

    const maxFormFileSize = bytes(cfg.maxFormFileSize);
    assert(Number.isInteger(maxFormFileSize), `[http] "maxFormFileSize" parameter: cannot parse "${cfg.maxFormFileSize}"`);

    // precomputes default headers
    const httpCfg = global.kuzzle.config.http;
    const headers = [
      [ 'Access-Control-Allow-Headers', httpCfg.accessControlAllowHeaders ],
      [ 'Access-Control-Allow-Methods', httpCfg.accessControlAllowMethods ],
      [ 'Access-Control-Allow-Origin', httpCfg.accessControlAllowOrigin ],
      [ 'Content-Type', 'application/json' ],
    ];

    for (const header of headers) {
      header[0] = Buffer.from(header[0]);
      header[1] = Buffer.from(header[1]);
    }

    return {
      enabled: cfg.enabled,
      headers,
      opts: {
        allowCompression: cfg.allowCompression,
        maxEncodingLayers: cfg.maxEncodingLayers,
        maxFormFileSize,
      },
    };
  }
}

/**
 * Returns the list of IP addresses
 *
 * @param {uWS.HttpResponse} response
 * @param {uWS.HttpRequest} request
 * @return {Array.<string>}
 */
function getHttpIps (response, request) {
  const ips = [Buffer.from(response.getRemoteAddressAsText()).toString()];

  const forwardHeader = request.getHeader('x-forwarded-for');

  if (forwardHeader && forwardHeader.length > 0) {
    for (const header of forwardHeader.split(',')) {
      const trimmed = header.trim();

      if (trimmed.length > 0) {
        ips.push(trimmed);
      }
    }
  }

  return ips;
}

module.exports = HTTPWS;