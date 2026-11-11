/**
 * lambda-captcha — a dependency-free image + audio CAPTCHA for server-rendered
 * pages on AWS Lambda, plus a gate that puts a whole Lambda web app behind it.
 *
 * Two ways to use it:
 *
 * - Embed a challenge in one of your own forms: `createCaptcha`, `renderFields`
 *   and `captcha.verify`.
 * - Gate every request to the app: `withCaptchaGate` (or `createGate`).
 *
 * The DynamoDB nonce store lives in `lambda-captcha/dynamodb`, so this entry
 * point never pulls in the AWS SDK.
 */
export { createCaptcha } from './challenge';
export type { Captcha, CaptchaOptions, Challenge, VerifyStatus } from './challenge';
export { renderFields, CAPTCHA_CSS, ANSWER_FIELD, TOKEN_FIELD } from './fields';
export type { FieldsOptions } from './fields';
export { memoryNonceStore } from './nonce';
export type { NonceStore } from './nonce';
export { createGate, withCaptchaGate, markPrivate } from './gate';
export type { Gate, GateEvent, GateOptions, GateResponse } from './gate';
