import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { NonceStore } from './nonce';

/**
 * DynamoDB-backed NonceStore: `lambda-captcha/dynamodb`.
 *
 * A separate entry point so the core package never imports the AWS SDK. The
 * SDK is a peer dependency: the Lambda Node.js runtime already provides it, so
 * bundle with `@aws-sdk/*` marked external.
 */
export interface DynamoNonceStoreOptions {
  tableName: string;
  /**
   * The item key for a nonce. The default, `{ pk: "captcha#<nonce>" }`, suits a
   * table whose partition key is a string attribute named `pk`. For a
   * single-table design, return your own key attributes, e.g.
   * `(n) => ({ PK: \`CAPTCHA#${n}\`, SK: 'USED' })`.
   */
  key?: (nonce: string) => Record<string, string>;
  /**
   * Attribute holding the expiry, in Unix seconds. Turn on DynamoDB TTL for it
   * and spent nonces delete themselves. Default `ttl`.
   */
  ttlAttribute?: string;
  /** Client to send with. Default: a DynamoDBDocumentClient, created on first use. */
  client?: Pick<DynamoDBDocumentClient, 'send'>;
}

export function dynamoNonceStore(options: DynamoNonceStoreOptions): NonceStore {
  const key = options.key ?? ((nonce: string) => ({ pk: `captcha#${nonce}` }));
  const ttlAttribute = options.ttlAttribute ?? 'ttl';
  let client = options.client;

  return {
    async consume(nonce, ttlSeconds) {
      client ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
      const Key = key(nonce);
      const [partitionKey] = Object.keys(Key);
      try {
        // The conditional write is the whole point: two concurrent submissions
        // of the same solved challenge race here and exactly one wins.
        await client.send(
          new PutCommand({
            TableName: options.tableName,
            Item: { ...Key, [ttlAttribute]: Math.floor(Date.now() / 1000) + ttlSeconds },
            ConditionExpression: 'attribute_not_exists(#k)',
            ExpressionAttributeNames: { '#k': partitionKey },
          }),
        );
        return true;
      } catch (err) {
        if ((err as Error).name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },
  };
}
