'use strict';

const should = require('should');

const { PreconditionError } = require('../../../index');
const KuzzleMock = require('../../mocks/kuzzle.mock');

const { IndexCache } = require('../../../lib/core/storage/indexCache');

describe('#core/storage/indexCache', () => {
  let indexCache;

  beforeEach(() => {
    new KuzzleMock();

    indexCache = new IndexCache();
  });

  describe('#addIndex', () => {
    it('should be able to add a new index to the cache', () => {
      should(indexCache.hasIndex('foo')).be.false();

      should(indexCache.addIndex('foo')).be.true();

      should(indexCache.hasIndex('foo')).be.true();
    });

    it('should do nothing if adding an already cached index', () => {
      should(indexCache.addIndex('foo')).be.true();
      should(indexCache.addIndex('foo')).be.false();
    });
  });

  describe('#addCollection', () => {
    it('should be able to add a new collection on an existing index', () => {
      indexCache.addIndex('foo');

      should(indexCache.hasCollection('foo', 'bar')).be.false();

      indexCache.addCollection('foo', 'bar');

      should(indexCache.hasCollection('foo', 'bar')).be.true();
    });

    it('should be able to add a new index/collection pair', () => {
      should(indexCache.hasIndex('foo')).be.false();

      indexCache.addCollection('foo', 'bar');

      should(indexCache.hasIndex('foo')).be.true();
      should(indexCache.hasCollection('foo', 'bar')).be.true();
    });
  });

  describe('#removeIndex', () => {
    it('should be able to remove an index', () => {
      indexCache.addIndex('foo');

      should(indexCache.hasIndex('foo')).be.true();

      indexCache.removeIndex('foo');

      should(indexCache.hasIndex('foo')).be.false();
    });

    it('should ignore non-existing indexes', () => {
      indexCache.removeIndex('foo');
    });
  });

  describe('#removeCollection', () => {
    it('should be able to remove a collection', () => {
      indexCache.addCollection('foo', 'bar');

      should(indexCache.hasCollection('foo', 'bar')).be.true();

      indexCache.removeCollection('foo', 'bar');
      should(indexCache.hasCollection('foo', 'bar')).be.false();
      should(indexCache.hasIndex('foo')).be.true();
    });

    it('should do nothing if the collection or the index does not exist', () => {
      indexCache.addCollection('foo', 'bar');

      indexCache.removeCollection('ohnoes');
      indexCache.removeCollection('foo', 'ohnoes');
      should(indexCache.hasCollection('foo', 'bar')).be.true();
    });
  });

  describe('#listIndexes', () => {
    it('should return an empty array on an empty cache', () => {
      should(indexCache.listIndexes()).be.an.Array().and.be.empty();
    });

    it('should return the list of cached indexes', () => {
      indexCache.addIndex('foo');
      indexCache.addCollection('foo', 'bar');
      indexCache.addCollection('qux', 'baz');

      should(indexCache.listIndexes()).match(['foo', 'qux']);
    });
  });

  describe('#listCollections', () => {
    it('should throw on an empty cache', () => {
      should(() => indexCache.listCollections('foo')).throw(PreconditionError, {
        id: 'services.storage.unknown_index',
      });
    });

    it('should return an empty array on an empty index', () => {
      indexCache.addIndex('foo');
      should(indexCache.listCollections('foo')).be.an.Array().and.be.empty();
    });

    it('should return the list of an index cached collections', () => {
      indexCache.addCollection('foo', 'bar');
      indexCache.addCollection('foo', 'baz');
      indexCache.addCollection('qux', 'qux');

      should(indexCache.listCollections('foo')).match(['bar', 'baz']);
    });
  });

  describe('#assertions', () => {
    it('should be able to run an assertion check on an index existence', () => {
      indexCache.addIndex('foo');

      should(() => indexCache.assertIndexExists('foo')).not.throw();
      should(() => indexCache.assertIndexExists('bar')).throw(PreconditionError, {
        id: 'services.storage.unknown_index',
      });
    });

    it('should be able to run an assertion check on a collection existence', () => {
      indexCache.addCollection('foo', 'bar');

      should(() => indexCache.assertCollectionExists('foo', 'bar')).not.throw();

      should(() => indexCache.assertCollectionExists('foo', 'baz'))
        .throw(PreconditionError, { id: 'services.storage.unknown_collection' });

      should(() => indexCache.assertCollectionExists('fooz', 'bar'))
        .throw(PreconditionError, { id: 'services.storage.unknown_index' });
    });
  });
});
