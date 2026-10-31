/**
 * How a customer reaches the TurnitPlus team. Plans are activated by hand (lib/account-plan.ts), so every locked screen
 * tells the customer to contact TurnitPlus; these say where. Both are set per deployment, because they are the owner's
 * details and not part of this public repository. NEXT_PUBLIC_ values are fixed at build time: changing one needs a new
 * deployment. While unset, nothing is shown: no placeholder address ever reaches a customer.
 */
export const CONTACT_EMAIL = (process.env.NEXT_PUBLIC_TURNITPLUS_CONTACT_EMAIL ?? "").trim() || null;
export const OPERATOR_NAME = (process.env.NEXT_PUBLIC_TURNITPLUS_OPERATOR_NAME ?? "").trim() || null;
