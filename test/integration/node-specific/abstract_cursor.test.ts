import { expect } from 'chai';
import { once } from 'events';
import * as sinon from 'sinon';
import { Transform } from 'stream';
import { inspect } from 'util';

import {
  type Collection,
  type FindCursor,
  MongoAPIError,
  type MongoClient,
  MongoCursorExhaustedError,
  MongoServerError
} from '../../mongodb';

describe('class AbstractCursor', function () {
  describe('regression tests NODE-5372', function () {
    let client: MongoClient;
    let collection: Collection;
    const docs = [{ count: 0 }, { count: 10 }];

    beforeEach(async function () {
      client = this.configuration.newClient();

      collection = client.db('abstract_cursor_integration').collection('test');

      await collection.insertMany(docs);
    });

    afterEach(async function () {
      await collection.deleteMany({});
      await client.close();
    });

    it('cursors can be iterated with hasNext+next', async function () {
      const cursor = collection
        // sort ensures that the docs in the cursor are in the same order as the docs inserted
        .find({}, { sort: { count: 1 } })
        .map(doc => ({ ...doc, count: doc.count + 1 }));

      for (let count = 0; await cursor.hasNext(); count++) {
        const received = await cursor.next();
        const actual = docs[count];

        expect(received.count).to.equal(actual.count + 1);
      }
    });
  });

  describe('cursor iteration APIs', function () {
    let client: MongoClient;
    let collection: Collection;
    const transformSpy = sinon.spy(doc => ({ ...doc, name: doc.name.toUpperCase() }));

    beforeEach(async function () {
      client = this.configuration.newClient();

      collection = client.db('abstract_cursor_integration').collection('test');

      await collection.insertMany([{ name: 'john doe' }]);
    });

    afterEach(async function () {
      transformSpy.resetHistory();

      await collection.deleteMany({});
      await client.close();
    });

    context(`hasNext()`, function () {
      context('when there is a transform on the cursor', function () {
        it(`the transform is NOT called`, async () => {
          const cursor = collection.find().map(transformSpy);

          const hasNext = await cursor.hasNext();
          expect(transformSpy).not.to.have.been.called;
          expect(hasNext).to.be.true;
        });
      });
    });

    const operations: ReadonlyArray<readonly [string, (arg0: FindCursor) => Promise<unknown>]> = [
      ['tryNext', (cursor: FindCursor) => cursor.tryNext()],
      ['next', (cursor: FindCursor) => cursor.next()],
      [
        'Symbol.asyncIterator().next',
        async (cursor: FindCursor) => {
          const iterator = cursor[Symbol.asyncIterator]();
          return iterator.next().then(({ value }) => value);
        }
      ],
      [
        'Cursor.stream',
        (cursor: FindCursor) => {
          const stream = cursor.stream();
          return once(stream, 'data').then(([doc]) => doc);
        }
      ]
    ] as const;

    for (const [method, func] of operations) {
      context(`${method}()`, function () {
        context('when there is a transform on the cursor', function () {
          it(`the transform is called`, async () => {
            const cursor = collection.find().map(transformSpy);

            const doc = await func(cursor);
            expect(transformSpy).to.have.been.calledOnce;
            expect(doc.name).to.equal('JOHN DOE');
          });
          context('when the transform throws', function () {
            it(`the error is propagated to the user`, async () => {
              const cursor = collection.find().map(() => {
                throw new Error('error thrown in transform');
              });

              const error = await func(cursor).catch(e => e);
              expect(error)
                .to.be.instanceOf(Error)
                .to.match(/error thrown in transform/);
              expect(cursor.closed).to.be.true;
            });
          });
        });

        context('when there is not a transform on the cursor', function () {
          it(`it returns the cursor's documents unmodified`, async () => {
            const cursor = collection.find();

            const doc = await func(cursor);
            expect(doc.name).to.equal('john doe');
          });
        });
      });
    }
  });

  describe('custom transforms with falsy values', function () {
    let client: MongoClient;
    const falseyValues = [0, 0n, NaN, '', false, undefined];

    let collection: Collection;

    beforeEach(async function () {
      client = this.configuration.newClient();

      collection = client.db('abstract_cursor_integration').collection('test');

      await collection.insertMany(Array.from({ length: 5 }, (_, index) => ({ index })));
    });

    afterEach(async function () {
      await collection.deleteMany({});
      await client.close();
    });

    it('wraps transform in result checking for each map call', async () => {
      const control = { functionThatShouldReturnNull: 0 };
      const makeCursor = () => {
        const cursor = collection.find();
        cursor
          .map(doc => (control.functionThatShouldReturnNull === 0 ? null : doc))
          .map(doc => (control.functionThatShouldReturnNull === 1 ? null : doc))
          .map(doc => (control.functionThatShouldReturnNull === 2 ? null : doc));
        return cursor;
      };

      for (const testFn of [0, 1, 2]) {
        control.functionThatShouldReturnNull = testFn;
        const error = await makeCursor()
          .toArray()
          .catch(error => error);
        expect(error).to.be.instanceOf(MongoAPIError);
      }
    });

    context('toArray() with custom transforms', function () {
      for (const value of falseyValues) {
        it(`supports mapping to falsey value '${inspect(value)}'`, async function () {
          const cursor = collection.find();
          cursor.map(() => value);

          const result = await cursor.toArray();

          const expected = Array.from({ length: 5 }, () => value);
          expect(result).to.deep.equal(expected);
        });
      }

      it('throws when mapping to `null` and cleans up cursor', async function () {
        const cursor = collection.find();
        cursor.map(() => null);

        const error = await cursor.toArray().catch(e => e);

        expect(error).be.instanceOf(MongoAPIError);
        expect(cursor.id.isZero()).to.be.true;
        // The first batch exhausted the cursor, the only thing to clean up is the session
        expect(cursor.session.hasEnded).to.be.true;
      });
    });

    context('Symbol.asyncIterator() with custom transforms', function () {
      for (const value of falseyValues) {
        it(`supports mapping to falsey value '${inspect(value)}'`, async function () {
          const cursor = collection.find();
          cursor.map(() => value);

          let count = 0;

          for await (const document of cursor) {
            expect(document).to.deep.equal(value);
            count++;
          }

          expect(count).to.equal(5);
        });
      }

      it('throws when mapping to `null` and cleans up cursor', async function () {
        const cursor = collection.find();
        cursor.map(() => null);

        try {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const document of cursor) {
            expect.fail('Expected error to be thrown');
          }
        } catch (error) {
          expect(error).to.be.instanceOf(MongoAPIError);
          expect(cursor.id.isZero()).to.be.true;
          // The first batch exhausted the cursor, the only thing to clean up is the session
          expect(cursor.session.hasEnded).to.be.true;
        }
      });
    });

    context('forEach() with custom transforms', function () {
      for (const value of falseyValues) {
        it(`supports mapping to falsey value '${inspect(value)}'`, async function () {
          const cursor = collection.find();
          cursor.map(() => value);

          let count = 0;

          function transform(value) {
            expect(value).to.deep.equal(value);
            count++;
          }

          await cursor.forEach(transform);

          expect(count).to.equal(5);
        });
      }

      it('throws when mapping to `null` and cleans up cursor', async function () {
        const cursor = collection.find();
        cursor.map(() => null);

        function iterator() {
          expect.fail('Expected no documents from cursor, received at least one.');
        }

        const error = await cursor.forEach(iterator).catch(e => e);
        expect(error).to.be.instanceOf(MongoAPIError);
        expect(cursor.id.isZero()).to.be.true;
        // The first batch exhausted the cursor, the only thing to clean up is the session
        expect(cursor.session.hasEnded).to.be.true;
      });
    });
  });

  describe('transform stream error handling', function () {
    let client: MongoClient;
    let collection: Collection;
    const docs = [{ count: 0 }];

    beforeEach(async function () {
      client = this.configuration.newClient();

      collection = client.db('abstract_cursor_integration').collection('test');

      await collection.insertMany(docs);
    });

    afterEach(async function () {
      await collection.deleteMany({});
      await client.close();
    });

    it('propagates errors to transform stream', async function () {
      const transform = new Transform({
        transform(data, encoding, callback) {
          callback(null, data);
        }
      });

      // MongoServerError: unknown operator: $bar
      const stream = collection.find({ foo: { $bar: 25 } }).stream({ transform });

      const error: Error | null = await new Promise(resolve => {
        stream.on('error', error => resolve(error));
        stream.on('end', () => resolve(null));
      });
      expect(error).to.be.instanceof(MongoServerError);
    });
  });

  describe('cursor end state', function () {
    let client: MongoClient;
    let cursor: FindCursor;

    beforeEach(async function () {
      client = this.configuration.newClient();
      const test = client.db().collection('test');
      await test.deleteMany({});
      await test.insertMany([{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }]);
    });

    afterEach(async function () {
      await cursor.close();
      await client.close();
    });

    describe('when the last batch has been received', () => {
      it('has a zero id and is not closed and is never killed', async function () {
        cursor = client.db().collection('test').find({});
        expect(cursor).to.have.property('closed', false);
        await cursor.tryNext();
        expect(cursor.id.isZero()).to.be.true;
        expect(cursor).to.have.property('closed', false);
        expect(cursor).to.have.property('killed', false);
      });
    });

    describe('when the last document has been iterated', () => {
      it('has a zero id and is closed and is never killed', async function () {
        cursor = client.db().collection('test').find({});
        await cursor.next();
        await cursor.next();
        await cursor.next();
        await cursor.next();
        expect(await cursor.next()).to.be.null;
        expect(cursor.id.isZero()).to.be.true;
        expect(cursor).to.have.property('closed', true);
        expect(cursor).to.have.property('killed', false);
      });
    });

    describe('when some documents have been iterated and the cursor is closed', () => {
      it('has a zero id and is not closed and is killed', async function () {
        cursor = client.db().collection('test').find({}, { batchSize: 2 });
        await cursor.next();
        await cursor.close();
        expect(cursor).to.have.property('closed', false);
        expect(cursor).to.have.property('killed', true);
        expect(cursor.id.isZero()).to.be.true;
        const error = await cursor.next().catch(error => error);
        expect(error).to.be.instanceOf(MongoCursorExhaustedError);
      });
    });
  });
});
