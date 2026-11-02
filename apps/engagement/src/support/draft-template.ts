// The one place the template key is named (#610).
//
// `support-reply-draft@1` is specified in REQUEST #667 and published by window 14, who own `packages/ai` —
// a template is frozen once published (a changed prompt is a new `v<N+1>`), so inventing one here would be
// either a cross-window edit or a fork of the registry. Until it lands, the gateway raises `TemplateError`
// before anything is rendered or sent, and the route answers 503 `unavailable`: configured, not ready.
//
// It is a constant rather than an inline string so that the day the template moves to v2, one line changes
// and every test that asserts the key fails loudly rather than passing against a stale prompt.
export const TEMPLATE_KEY = 'support-reply-draft@1';
