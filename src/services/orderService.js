/**
 * Business rule for Pay-on-pickup eligibility
 * @param {Object} orderData - The order data to check (total, deliveryZone, etc.)
 * @returns {boolean}
 */
export function isPayOnPickupEligible(orderData) {
  const ELIGIBLE_ZONES = ['ibadan-central', 'ibadan-north']; // adjust as business rules evolve
  const MAX_TOTAL = 50000;
  
  // Note: orderData might be a partial object from checkout or a full Order document
  const total = orderData.total;
  const deliveryZone = orderData.shippingAddress?.city?.toLowerCase().replace(/\s+/g, '-'); 
  
  // If we don't have a specific zone mapping yet, we'll use the city as a proxy for now 
  // or expect the client to pass a zone identifier.
  // For this implementation, we'll check if the city (normalized) is in eligible zones.
  
  return total <= MAX_TOTAL && ELIGIBLE_ZONES.includes(deliveryZone);
}
