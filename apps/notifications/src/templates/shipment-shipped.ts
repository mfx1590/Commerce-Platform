// The shipping notice (#360): the carrier has the parcel; here is how to follow it.
import { formatDate, tpl, raw } from '../format.js';
import type { RenderContext, RenderedContent, ShipmentShippedData } from '../types.js';
import { addressHtml, addressLines, firstName, footerLines, layout, safeUrl } from './layout.js';
import { strings } from './strings.js';

export function renderShipmentShipped(
  data: ShipmentShippedData,
  ctx: RenderContext,
): RenderedContent {
  const s = strings[ctx.locale];
  const subject = s.shipSubject(ctx.brand.name, data.displayId);
  const greeting = s.greeting(firstName(data.shippingAddress));
  const shipped = formatDate(data.shippedAt, ctx.locale, ctx.timeZone);
  const carrier = data.service ? `${data.carrier} (${data.service})` : data.carrier;
  const trackingUrl = safeUrl(data.trackingUrl);
  const itemLabel = (i: ShipmentShippedData['items'][number]): string =>
    i.variantTitle && i.variantTitle !== i.title ? `${i.title} (${i.variantTitle})` : i.title;

  const text = [
    greeting,
    '',
    s.shipIntro,
    '',
    `${s.orderNumber}: #${data.displayId}`,
    `${s.shippedOn}: ${shipped}`,
    `${s.carrier}: ${carrier}`,
    ...(data.trackingNumber ? [`${s.trackingNumber}: ${data.trackingNumber}`] : []),
    ...(trackingUrl ? [`${s.trackParcel}: ${trackingUrl}`] : []),
    '',
    `${s.itemsInParcel}:`,
    ...data.items.map((i) => `${i.quantity} × ${itemLabel(i)}`),
    '',
    `${s.deliveryAddress}:`,
    ...addressLines(data.shippingAddress),
    '',
    s.questions(ctx.brand.supportEmail),
    '',
    ...footerLines(ctx),
    '',
  ].join('\n');

  const body = tpl`<p>${greeting}</p>
    <p>${s.shipIntro}</p>
    <p>
      <strong>${s.orderNumber}:</strong> #${data.displayId}<br />
      <strong>${s.shippedOn}:</strong> ${shipped}<br />
      <strong>${s.carrier}:</strong> ${carrier}${
        data.trackingNumber
          ? raw(tpl`<br /><strong>${s.trackingNumber}:</strong> ${data.trackingNumber}`)
          : ''
      }
    </p>
    ${
      trackingUrl
        ? raw(
            tpl`<p>
              <a
                href="${trackingUrl}"
                style="display:inline-block;padding:10px 18px;background:#18181b;color:#ffffff;text-decoration:none;border-radius:6px;"
                >${s.trackParcel}</a
              >
            </p>`,
          )
        : ''
    }
    <p><strong>${s.itemsInParcel}</strong></p>
    <ul style="margin:0 0 16px;padding-left:20px;">
      ${raw(data.items.map((i) => tpl`<li>${i.quantity} × ${itemLabel(i)}</li>`).join('\n'))}
    </ul>
    <p><strong>${s.deliveryAddress}</strong><br />${raw(addressHtml(data.shippingAddress))}</p>
    <p>${s.questions(ctx.brand.supportEmail)}</p>`;

  return { subject, text, html: layout(ctx, subject, body) };
}
