import { z } from 'zod';

export const fromCents = (c: number) => Math.round(c) / 100;
export const fromMilli = (m: number) => m / 1000;
export const toMilli = (odds: number) => Math.round(odds * 1000);

/** API accepts amounts in major units (e.g. 10.5) and converts to integer cents. Max 2 decimals. */
export const moneyIn = z
  .number()
  .positive()
  .max(10_000_000)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'At most 2 decimal places')
  .transform((v) => Math.round(v * 100));
