/**
 * Varios productos con el MISMO código en un registro (p. ej. varios productos
 * de la misma orden). Cada producto necesita un código único dentro del
 * registro porque las fotos y las acciones van por código. Cuando el código ya
 * está y llega otro producto con OTRA descripción, se guarda como
 * "CÓDIGO · DESCRIPCIÓN" (y `orderCode` = el código original).
 */

export interface ExistingProduct {
  productCode: string
  orderCode?: string
  labelData?: { descripcion?: string }
}

export type VariantResult =
  | { ok: true; productCode: string; orderCode?: string }
  | { ok: false; message: string }

const MAX_DESC = 60

function eq(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()
}

/** Parte principal de la descripción (antes de " · Columna: valor"). */
export function mainDescription(desc: string | undefined): string {
  return String(desc ?? '').split(' · ')[0].replace(/\s+/g, ' ').trim()
}

/** Código único para un producto que comparte código con otro del registro. */
export function variantCode(code: string, desc: string): string {
  return `${code.trim()} · ${mainDescription(desc).slice(0, MAX_DESC).trim()}`.toUpperCase()
}

/**
 * Decide con qué código se agrega el producto.
 *  - Código libre en el registro → se usa tal cual.
 *  - Código ocupado y `allowSameCode` con descripción distinta → variante.
 *  - Mismo código y misma descripción (o sin permiso/descripción) → conflicto.
 */
export function resolveProductCode(
  existing: ExistingProduct[],
  code: string,
  descripcion: string | undefined,
  allowSameCode: boolean,
): VariantResult {
  const clean = code.trim()
  const taken = (c: string) => existing.some((p) => eq(p.productCode, c))
  const already: VariantResult = { ok: false, message: `El producto "${clean}" ya está registrado en esta operación.` }
  if (!taken(clean)) return { ok: true, productCode: clean }
  if (!allowSameCode) return already
  const desc = mainDescription(descripcion)
  if (!desc) return already
  // Mismo código y misma descripción: es el mismo producto.
  const sameOrder = existing.filter((p) => eq(p.productCode, clean) || eq(p.orderCode, clean))
  if (sameOrder.some((p) => eq(mainDescription(p.labelData?.descripcion), desc))) return already
  const v = variantCode(clean, desc)
  if (taken(v)) return { ok: false, message: `El producto "${v}" ya está registrado en esta operación.` }
  return { ok: true, productCode: v, orderCode: clean }
}
