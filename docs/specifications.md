# Kuzzle Specifications

## Message structure

Messages (ie. requests sent to Kuzzle to publish data, subscribe to something, or search for specific data) use internally the following JSON structure :

```json
{
  "controller": <controller>,
  ["requestId": <requestId>,]
  "collection": <collection>,
  "action": <action>,
  [<optionnal msg attributes>]
}
```
* &lt;controller&gt; : **write** | **read** | **subscribe**
* &lt;requestId&gt; _(optionnal)_ : a unique identifier for the message (if not set, will be automatically calculated by Kuzzle)
* &lt;collection&gt; : the collection name
* &lt;action&gt; : the action name, depending to the controller (see below)
* &lt;optionnal msg attributes&gt; : addionnal attributes, depending on the controller/action (see below), or custom attributes for your app.


### Controllers


#### write

```json
{
  "controller": "write",
  ["requestId": <requestId>,]
  "collection": <collection>,
  "action": <"create"|"update"|"delete">,
  ["persist": <true|false>,]
  ["id": <id>,]
  ["content": <content>,]
}
```
* &lt;requestId&gt; _(optionnal)_ : if set : identifies the room where where the feedback messages will be sent.
* &lt;action&gt; : **create** | **update** | **delete**
* &lt;persist&gt; (only for **create** ? ):
    * if _true_ : the content has to be stored to the persistent layer
    * if _false_ : the content will be volatile and used only by the real-time layer
* &lt;id&gt; : the Content ID :
    * for **create** : optionnal.
        will be automatically generated by Kuzzle if not set
        **Note : If id is set and corresponds to an existing object, do we update it or raise an error ?**
     * for **update** : mandatory.
     * for **delete** : optionnal. If not set, delete the entire collection. **Note : To delete collection, do we use no content ID or content ID = all ? (no content ID seems a little dangerous...**
* &lt;content&gt;
    * for **create** : the content to be added to the collection.
    * for **update** : only the JSON attributes that need to be changed.
    * for **delete** : _unused_

#### subscribe

```json
{
  "controller": "subscribe",
  "requestId": <requestId>,
  "collection": <collection>,
  "action": <"on"|"off">,
  ["content": <content>,]
}
```

* &lt;requestId&gt; : the local room where Kuzzle should publish requested messages
* &lt;collection&gt; : the collection name
* &lt;action&gt; : **on** | **off**
* &lt;content&gt;
    * for **on** : the filters to subscribe to (see [filters syntax] for details)
    * for **off** : _unused_

#### read

```json
{
  "controller": "read",
  "requestId": <requestId>,
  "collection": <collection>,
  "action": <"get"|"search">,
  ["id": <id>,]
  ["filters": <filters>,]
}
```

* &lt;requestId&gt; : the local room where Kuzzle should send requested data
* &lt;collection&gt; : the collection name
* &lt;action&gt; : **get** | **search**
* &lt;id&gt; :
    * for **get** : identifies the content to retrive (if not set, the whole collection will be given ?)
    * for **search** : _unused_
* &lt;filters&gt;
    * for **get** : _unused_
    * for **search** : the search filters (see [filters syntax] for details)


### Protocol dependant encapsulation

As Kuzzke API can be called through distinct network protocols, the encapsulation of messages will depend  of used protocol :

#### REST

| HTTP Method | URL format | body | controller | action | comment |
| --- | --- | --- | --- | --- | --- |
| **GET** | http(s)://kuzzle.domain/&lt;collection&gt;/ | _empty_  | **read** |  **search** | list all contents of given collection |
| **GET** | http(s)://kuzzle.domain/&lt;collection&gt;/&lt;id&gt; | _empty_ | **read** | **get** | get a single content |
| **PUT** | http(s)://kuzzle.domain/&lt;collection&gt; | `{<data_content>}` | **write** | **replace** | replace the entire collection with given contents |
| **PUT** | http(s)://kuzzle.domain/&lt;collection&gt;/&lt;id&gt; | `{<data_content>}` | **write** | **update** | update a content (or create it if not exsist) |
| **POST** | http(s)://kuzzle.domain/&lt;collection&gt; |  `{<data_content>}` | **write** | **create** | create a new content |
| **POST** | http(s)://kuzzle.domain/&lt;collection&gt;/search | `{<search_filters>}` | **read** |  **search** | search contents according to given filters |
| **DELETE** | http(s)://kuzzle.domain/&lt;collection&gt; | _empty_ | **write** | **delete** | delete the entire collection |
| **DELETE** | http(s)://kuzzle.domain/&lt;collection&gt;/&lt;id&gt; | _empty_ | **write** | **delete** | delete the given content |

* `{<data_content>}` :

```json
{
  ["persist": <true|false>,]
  "content": <content>
}
```

* `{<search_filters>}` :

_(to be defined)_


##### Notes :

* **subscribe** controller is not available for REST API.
* requestId is not needed here. For kuzzle internal needs, its value is automatically calculated with a hash of request content.
* For each methods, we follow the [HTTP Standard Status Codes][ietf-http-status-codes] within the HTTP responses.

#### Websocket

At kuzzle side, a websocket room is listenning for each controller.

At client side, we should just encapsulate the messages like this :

```javascript
socket.emit('<controller>', {
  ["requestId": <requestId>,]
  "collection": <collection>,
  "action": <action>,
  [<optionnal msg attributes>]
});
```

#### AMQP / STOMP / MQTT 

Kuzzle is listening for **amq.topic** echange, filtering following routing key `<controller>.<collection>.<action>`.

Messages send to this exchange must be in JSON and contains controller/action depending attributes (see above).

Additionnaly, the client SHOULD give a queue or a connection identifier if he needs to get feedback for the request (mandatory for **subscribe** controller) :

* **AMQP** : add a `reply-to` property to the message
* **STOMP** : add a `reply-to` header, like this :

```
SEND
destination:/exchange/amq.topic/write.information.create
reply-to:/temp-queue/availabilitiy
content-type:application/json

{...}

^@
```

_(NB: This will automatically subscribes the client to the reply-to queue.)_

* **MQTT** : add the client ID to the message body :

```json
{
  "mqttClientId": "mqtt_gbLzz12URZRKVcIpOCqc11SvMN7",
  ["requestId": <requestId>,]
  [<optionnal msg attributes>]
}
```

_(NB: Kuzzle will send messages to the topic exchange **amqp.topic**, with following destination : `mqtt.<mqttClientId>.<requestId>`, so the client has to subscribe to this routing key as well.)_


[//]: # (=========================================================)
[//]: # (Links)

[ietf-http-status-codes]: http://www.ietf.org/assignments/http-status-codes/http-status-codes.xml
[filters syntax]: filters.md
