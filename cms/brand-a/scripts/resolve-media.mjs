/**
 * Media slots → Cloudinary delivery URLs, at seed time.
 *
 * The content in `../content/*.json` never holds a URL. An image is written as a reference to a
 * slot in `../media/manifest.json`:
 *
 *   { "_type": "image", "mediaSlot": "home-hero-01" }               optional
 *   { "_type": "image", "mediaSlot": "og-default", "mediaRequired": true }
 *
 * and this module turns it into what the schema accepts — `{ _type, cloudinaryUrl, alt }`, the alt
 * text taken from the manifest for the document's locale. Why not commit the URLs: a Cloudinary URL
 * names the cloud, and the owner has not created one yet. A committed placeholder cloud would be a
 * fake URL in the dataset the day someone seeds; a slot cannot be.
 *
 * The cloud name is `CLOUDINARY_CLOUD_NAME_BRAND_A`, else `CLOUDINARY_CLOUD_NAME` (both in
 * `.env.example`). It is public — it is in every delivery URL. The API key and secret are **never
 * read here**: uploading is `upload-media.mjs`'s job, run by the owner.
 *
 * Without a cloud name:
 * - an optional image is left out — the field is deleted, and an `imageBlock` (whose image the schema
 *   requires) is removed from its list as a whole;
 * - a `mediaRequired` image is an error, never a silent skip.
 *
 * Always, with or without a cloud name, these are errors: a slot the manifest does not have, a slot
 * that is a video, a referenced slot without alt text for the document's locale, and a slot whose
 * proportions do not fit where it is placed (`ALLOWED_ASPECTS`).
 */

/** Where an image may be placed, by the aspect ratios that fit there. */
export const ALLOWED_ASPECTS = {
  hero: ['3:2'],
  imageBlock: ['3:2', '3:4'],
  ogImage: ['16:9'],
};

/**
 * The cloud name, or `undefined` when neither variable is set. Throws when one is set but is not a
 * valid cloud name. Reads exactly these two variables and nothing else.
 */
export function cloudNameFrom(env) {
  const value = env.CLOUDINARY_CLOUD_NAME_BRAND_A || env.CLOUDINARY_CLOUD_NAME;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const name = value.trim();
  // A cloud name becomes a URL path segment. Anything else is a typo or an injected path, and it fails
  // loudly: treating it as "absent" would silently seed every image out of the content.
  if (!CLOUD_NAME.test(name)) {
    throw new Error(
      `Cloudinary cloud name ${JSON.stringify(name)} is not valid (expected ${CLOUD_NAME}); ` +
        'check CLOUDINARY_CLOUD_NAME_BRAND_A / CLOUDINARY_CLOUD_NAME',
    );
  }
  return name;
}

/** What a Cloudinary cloud name may contain. */
export const CLOUD_NAME = /^[a-z0-9_-]+$/;

export function deliveryUrl(cloudName, slot) {
  const type = slot.kind === 'video' ? 'video' : 'image';
  return `https://res.cloudinary.com/${cloudName}/${type}/upload/${slot.publicId}`;
}

const DROP = Symbol('drop');

/**
 * @param {object[]} documents  authored documents, as read from content/
 * @param {{ slots: object[] }} manifest
 * @param {{ cloudName?: string }} options
 * @returns {{ documents: object[], dropped: number, errors: string[], resolved: number }}
 */
export function resolveMedia(documents, manifest, { cloudName } = {}) {
  const bySlot = new Map(manifest.slots.map((slot) => [slot.slot, slot]));
  const errors = [];
  let dropped = 0;
  let resolved = 0;

  const resolveImage = (ref, position, doc, path) => {
    const where = `${doc._id}${path}`;
    const slot = bySlot.get(ref.mediaSlot);
    if (slot === undefined) {
      errors.push(`${where}: media slot "${ref.mediaSlot}" is not in media/manifest.json`);
      return DROP;
    }
    if (slot.kind !== 'image') {
      errors.push(`${where}: media slot "${ref.mediaSlot}" is a ${slot.kind}, not an image`);
      return DROP;
    }
    const allowed = ALLOWED_ASPECTS[position];
    if (allowed !== undefined && !allowed.includes(slot.aspect)) {
      errors.push(
        `${where}: "${ref.mediaSlot}" is ${slot.aspect}; a ${position} takes ${allowed.join(' or ')}`,
      );
      return DROP;
    }
    const alt = slot.alt?.[doc.locale];
    if (typeof alt !== 'string' || alt.trim() === '') {
      errors.push(`${where}: media slot "${ref.mediaSlot}" has no ${doc.locale} alt text`);
      return DROP;
    }
    if (cloudName === undefined) {
      if (ref.mediaRequired === true) {
        errors.push(
          `${where}: "${ref.mediaSlot}" is required, and no cloud name is set ` +
            '(CLOUDINARY_CLOUD_NAME_BRAND_A or CLOUDINARY_CLOUD_NAME)',
        );
      } else {
        dropped += 1;
      }
      return DROP;
    }
    resolved += 1;
    const { mediaSlot: _slot, mediaRequired: _required, ...rest } = ref;
    return { ...rest, _type: 'image', cloudinaryUrl: deliveryUrl(cloudName, slot), alt };
  };

  const walk = (value, position, doc, path) => {
    if (Array.isArray(value)) {
      return value
        .map((item, i) => walk(item, undefined, doc, `${path}[${i}]`))
        .filter((item) => item !== DROP);
    }
    if (value === null || typeof value !== 'object') return value;
    if (typeof value.mediaSlot === 'string') return resolveImage(value, position, doc, path);

    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const childPosition =
        key === 'image' && (value._type === 'hero' || value._type === 'imageBlock')
          ? value._type
          : key === 'ogImage'
            ? 'ogImage'
            : undefined;
      const next = walk(child, childPosition, doc, `${path}.${key}`);
      if (next === DROP) {
        // The schema requires an imageBlock's image, so the block goes with it.
        if (value._type === 'imageBlock' && key === 'image') return DROP;
        continue;
      }
      out[key] = next;
    }
    return out;
  };

  const out = documents.map((doc) => walk(doc, undefined, doc, ''));
  return { documents: out, dropped, errors, resolved };
}
