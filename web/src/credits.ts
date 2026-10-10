export const creditCount = (usd?: number | null) => Math.max(0, Math.ceil(((Number(usd) || 0) - 1e-9) * 100));
export const credits = (usd?: number | null) => `${creditCount(usd).toLocaleString()} credits`;
export const creditsShort = (usd?: number | null) => creditCount(usd).toLocaleString();
