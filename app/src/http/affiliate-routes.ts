import { requireAdmin } from '../server/admin-gate';
import { autoPlaceAffiliate, placeAffiliate } from '../server/affiliate';
import { autoPlacementInput, placementInput } from './input';
import type { ApiApplication } from './types';

export function registerAffiliateRoutes(app: ApiApplication) {
  app.post('/api/affiliate/auto-place', requireAdmin, async context => {
    const input = autoPlacementInput.parse(await context.req.json());
    return context.json(await autoPlaceAffiliate(input));
  });

  app.post('/api/affiliate/place', requireAdmin, async context => {
    const input = placementInput.parse(await context.req.json());
    return context.json(await placeAffiliate(input));
  });
}
