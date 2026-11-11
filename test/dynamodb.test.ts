import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamoNonceStore } from '../src/dynamodb';

/** A stand-in client that behaves like a conditional put against a real table. */
function fakeClient() {
  const items = new Map<string, Record<string, unknown>>();
  const sent: PutCommand[] = [];
  return {
    sent,
    async send(cmd: PutCommand) {
      sent.push(cmd);
      const id = JSON.stringify(Object.entries(cmd.input.Item!).filter(([k]) => k !== 'ttl' && k !== 'expires'));
      if (items.has(id)) {
        const err = new Error('The conditional request failed');
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
      items.set(id, cmd.input.Item!);
      return {};
    },
  };
}

test('consumes a nonce once, with a conditional put and a TTL', async () => {
  const client = fakeClient();
  const store = dynamoNonceStore({ tableName: 'T', client: client as never });
  const before = Math.floor(Date.now() / 1000);
  assert.equal(await store.consume('abc', 180), true);
  assert.equal(await store.consume('abc', 180), false);
  assert.equal(await store.consume('def', 180), true);

  const input = client.sent[0].input;
  assert.equal(input.TableName, 'T');
  assert.equal(input.Item!.pk, 'captcha#abc');
  assert.ok((input.Item!.ttl as number) >= before + 180);
  assert.equal(input.ConditionExpression, 'attribute_not_exists(#k)');
  assert.deepEqual(input.ExpressionAttributeNames, { '#k': 'pk' });
});

test('takes a custom key and TTL attribute for single-table designs', async () => {
  const client = fakeClient();
  const store = dynamoNonceStore({
    tableName: 'App',
    client: client as never,
    key: (n) => ({ PK: `CAPTCHA#${n}`, SK: 'USED' }),
    ttlAttribute: 'expires',
  });
  assert.equal(await store.consume('n1', 60), true);
  assert.equal(await store.consume('n1', 60), false);
  const input = client.sent[0].input;
  assert.deepEqual({ PK: input.Item!.PK, SK: input.Item!.SK }, { PK: 'CAPTCHA#n1', SK: 'USED' });
  assert.equal(typeof input.Item!.expires, 'number');
  assert.deepEqual(input.ExpressionAttributeNames, { '#k': 'PK' });
});

test('other errors propagate', async () => {
  const store = dynamoNonceStore({
    tableName: 'T',
    client: { send: async () => Promise.reject(new Error('throttled')) } as never,
  });
  await assert.rejects(store.consume('x', 60), /throttled/);
});
