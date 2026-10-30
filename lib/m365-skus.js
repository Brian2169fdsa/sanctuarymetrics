/* ============================================================================
   Microsoft 365 license prices, by the SKU part number Graph returns.

   Microsoft Graph says which licenses the tenant owns and who holds them; it
   does not say what we pay. These are the pre-tax unit prices on Sanctuary's
   own invoices (Jul–Sep 2026). Edit this file when a price or term changes.

     term 'monthly'  month-to-month: a seat removed comes off the next invoice
     term 'annual'   annual commitment: a removed seat is reclaimed for the next
                     hire, but the bill only drops at renewal

   A SKU that isn't listed still shows up, by its part number, with no price:
   its seats are counted but never put in a dollar figure. The daily sync
   reports it under "warnings" so it can be added here.
   ========================================================================== */

const SKUS = {
  O365_BUSINESS_ESSENTIALS: { name: 'Microsoft 365 Business Basic', price: 7.35, term: 'annual' },
  O365_BUSINESS_PREMIUM: { name: 'Microsoft 365 Business Standard', price: 14.21, term: 'annual' },
  SPB: { name: 'Microsoft 365 Business Premium', price: 26.40, term: 'monthly' },
  EXCHANGEENTERPRISE: { name: 'Exchange Online (Plan 2)', price: 9.60, term: 'monthly' },
  Microsoft_365_Copilot: { name: 'Microsoft 365 Copilot', price: 31.50, term: 'annual' },
  AAD_PREMIUM_P2: { name: 'Microsoft Entra ID P2', price: 10.50, term: 'annual' },
  FLOW_FREE: { name: 'Microsoft Power Automate Free', price: 0, term: 'free' },
  POWERAPPS_DEV: { name: 'Microsoft Power Apps for Developer', price: 0, term: 'free' },
  POWER_BI_STANDARD: { name: 'Microsoft Fabric (Free)', price: 0, term: 'free' }
};

const BASIC = 'Microsoft 365 Business Basic';
const STANDARD = 'Microsoft 365 Business Standard';
const PREMIUM = 'Microsoft 365 Business Premium';
const EXO2 = 'Exchange Online (Plan 2)';

function sku(part) {
  return SKUS[part] || { name: part, price: null, term: 'unknown' };
}

module.exports = { SKUS: SKUS, sku: sku, BASIC: BASIC, STANDARD: STANDARD, PREMIUM: PREMIUM, EXO2: EXO2 };
