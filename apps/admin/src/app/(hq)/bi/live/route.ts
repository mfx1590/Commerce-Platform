import { liveResponse } from '../_lib/handlers';

export const dynamic = 'force-dynamic';

/** The HQ live tiles' poll (#604): every store the principal may see. */
export async function GET(): Promise<Response> {
  return liveResponse();
}
