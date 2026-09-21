/**
 * Structured data, server-rendered into the page.
 *
 * `JSON.stringify` output is escaped before it reaches `dangerouslySetInnerHTML`: a product title or
 * description is API data, and a `</script>` sequence inside it would otherwise close this tag early
 * and turn the rest of the payload into live markup. Replacing `<` is enough to make that
 * impossible, and `<` parses back to the same string in JSON.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}

export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
