import type { ScrapedProduct, Collection } from './parse';
export type { ScrapedProduct, Collection };

export type Component = 'cabinet' | 'closet' | 'countertop' | 'sink' | 'faucet' | 'mirror';
export const SHARED_COMPONENTS = ['countertop', 'sink', 'faucet', 'mirror'] as const;
export type SharedComponent = (typeof SHARED_COMPONENTS)[number];
export type MatchKind = 'exact_sku' | 'url' | 'name_size_colour' | 'manual' | 'estimated';

/** commands.schema.json#/$defs/config — indices are in the booth-resolved option space (QA-007). */
export interface SetConfig {
  productId: string;
  sizeIndex: number;
  colourIndex: number;
  countertopSizeIndex?: number;
  countertopColourIndex?: number;
  closetSizeIndex?: number;
  closetColourIndex?: number;
  sinkSizeIndex?: number;
  sinkColourIndex?: number;
  faucetSizeIndex?: number;
  faucetColourIndex?: number;
  mirrorSizeIndex?: number;
  mirrorColourIndex?: number;
}

/**
 * catalog-mapping.schema.json#/$defs/mapping. For shared components (countertop, sink, faucet, mirror) the booth
 * resolves options per cabinet size (AShowroomBooth::GetResolvedComponentOptions): dangling ids are skipped, colours are
 * filtered by SizeIndices and re-indexed, faucets depend on the countertop type. Such entries carry `cabinetSizeIndex`
 * (and `topKind` for faucets); sizeIndex/colourIndex are then the resolved indices used in `config`.
 */
export interface Mapping {
  productId: string;
  collection?: Collection;
  component: Component;
  cabinetSizeIndex?: number;
  topKind?: 'SurfaceMounted' | 'BuiltIn';
  sharedId?: string;
  sizeIndex: number;
  sizeName?: string;
  colourIndex: number;
  rawColourIndex?: number;
  colourName?: string;
  articleCode: string;
  priceBYN: number;
  name?: string;
  url?: string;
  image?: string;
  dimensionsCm?: { width?: number; depth?: number; height?: number };
  match: MatchKind;
  /** Part code as printed inside bundle articles (e.g. MIL80A, CMA80W). */
  partCode?: string;
  /** For estimated entries: the article whose price was borrowed. */
  estimatedFrom?: string;
  note?: string;
}

export interface BaseLine {
  articleCode: string;
  name: string;
  priceBYN: number;
  url?: string;
  image?: string;
  dimensionsCm?: { width?: number; depth?: number; height?: number };
  match: MatchKind;
  note?: string;
}

/**
 * Price source for "cabinet + countertop option": either one sellable bundle article (MIL80A+CMA80W) or the standalone
 * cabinet and top articles, or an estimate. Keyed in the resolved space.
 */
export interface Bundle {
  productId: string;
  sizeIndex: number;
  colourIndex: number;
  top: 'countertop';
  topSizeIndex: number;
  topColourIndex: number;
  topKind?: 'SurfaceMounted' | 'BuiltIn';
  lines: BaseLine[];
  match: MatchKind;
  note?: string;
}

/** Normalised view of the UE export (DT_FurnitureCatalog + DT_Shared*). */
export interface UeColour {
  index: number;
  name: string;
  sku?: string;
  url?: string;
  sizeIndices?: number[];
  thumbnail?: string;
  /** In a resolved model: the index in the row's full colour list. */
  rawIndex?: number;
  /** The DataTable ProductName as written (before the colour word was extracted). */
  productName?: string;
}
export interface ResolvedModel {
  index: number;
  rowId: string;
  kind?: string;
  name?: string;
  widthCm?: number;
  heightCm?: number;
  depthCm?: number;
  /** BuiltIn countertop without a mesh for this size: the booth falls back to this SurfaceMounted row. */
  fallbackFrom?: string;
  colours: UeColour[];
}
export interface ResolvedSpace {
  countertop: ResolvedModel[];
  sink: ResolvedModel[];
  faucet: { SurfaceMounted: ResolvedModel[]; BuiltIn: ResolvedModel[] };
  mirror: ResolvedModel[];
}
export interface UeProduct {
  productId: string;
  collection?: Collection;
  displayName?: string;
  cabinet: { sizes: { index: number; name: string; widthCm?: number; depthCm?: number; heightCm?: number }[]; colours: UeColour[] };
  closetModels: { index: number; name?: string; widthCm?: number; heightCm?: number; colours: UeColour[] }[];
  allowed: Record<SharedComponent, string[]>;
  showInConstructor?: boolean;
  /** CombinationsMetadata SKUs: key "sizeIndex:colourIndex" (cabinet) */
  cabinetSkus?: Record<string, string>;
  /** ClosetOptions.CombinationsMetadata SKUs: key "modelIndex:colourIndex" */
  closetSkus?: Record<string, string>;
  /** Booth-resolved shared-component options per cabinet sizeIndex. */
  resolved: Record<string, ResolvedSpace>;
}
export interface UeSharedRow {
  id: string;
  component: SharedComponent;
  name?: string;
  widthCm?: number;
  heightCm?: number;
  depthCm?: number;
  /** ECountertopType (BuiltIn | SurfaceMounted) or EFaucetType (Standard | Integrated) */
  kind?: string;
  meshes?: string[];
  colours: UeColour[];
}

export interface CatalogIndexData {
  syncedAt: string;
  source: string;
  products: ScrapedProduct[];
  mappings: Mapping[];
  bundles: Bundle[];
  unmapped: { productId: string; component: Component; cabinetSizeIndex?: number; sizeIndex: number; colourIndex: number; reason: string }[];
  ue: { products: UeProduct[]; shared: UeSharedRow[]; tiles?: { id: string; name: string }[]; exportedAt?: string };
}

export interface QuoteLine {
  component: Component;
  articleCode: string;
  name: string;
  price: number;
  url?: string;
  image?: string;
  /** Price borrowed from a sibling article (flagged «цена уточняется»). */
  estimated?: boolean;
  /** No price source at all (price 0, shown as «цена уточняется», excluded from the total). */
  unpriced?: boolean;
  dimensionsCm?: { width?: number; depth?: number; height?: number };
  includes?: Component[];
}
export interface Quote {
  lines: QuoteLine[];
  total: number;
  currency: 'BYN';
  estimated: boolean;
  /** Components listed without a price (e.g. mirror, vessel sink not sold on oliveeka.by). */
  unpriced: string[];
  complete: boolean;
  missing: string[];
}
