/**
 * The product-media upload limits (#870 item 5, PR B). Plain ESM so `next.config.mjs` can import it.
 *
 * `MEDIA_MAX_BYTES` is the ceiling `createMediaUploadParams` answers (`max_bytes`, 10 MiB — the
 * core's `UPLOAD_MAX_BYTES`); the upload action refuses anything above the value the API returns
 * for that upload, and a test pins this constant to the API's ceiling.
 *
 * `SERVER_ACTION_BODY_LIMIT` is what Next accepts for ANY server action body. A server action
 * receives its multipart body already parsed, so this framework limit is the cap on the stream: it
 * is the file ceiling plus a small envelope for the multipart boundaries and the alt-text field,
 * not more. (Next's default is 1 MB, below one product photo.)
 */

/** 10 MiB: `createMediaUploadParams.max_bytes`. */
export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;

/** Room for the multipart boundaries, headers and the small text fields beside the file. */
export const MULTIPART_ENVELOPE_BYTES = 64 * 1024;

/** In bytes, for `experimental.serverActions.bodySizeLimit`. */
export const SERVER_ACTION_BODY_LIMIT = MEDIA_MAX_BYTES + MULTIPART_ENVELOPE_BYTES;
