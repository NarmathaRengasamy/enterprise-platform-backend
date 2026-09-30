/**
 * Types for the Business Category → Product Type feature (design §5, §6.2).
 * snake_case throughout: this is the new product module's wire format.
 */

export const FIELD_TYPES = ['enum', 'number', 'boolean', 'date', 'text', 'translated_text'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FULFILMENTS = ['goods', 'service', 'rental', 'digital'] as const;
export type Fulfilment = (typeof FULFILMENTS)[number];

export const TRACKINGS = ['none', 'batch', 'serial'] as const;
export type Tracking = (typeof TRACKINGS)[number];

export const LANGUAGES = ['en', 'ta', 'hi'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Translatable text: English is always present. */
export interface Translated {
  en: string;
  ta?: string;
  hi?: string;
}

export interface FieldOption {
  value: string;
  label: Translated;
  deprecated: boolean;
}

export interface FieldDefinition {
  key: string;
  label: Translated;
  type: FieldType;
  unit?: string;
  min?: number;
  max?: number;
  options: FieldOption[];
  variant_forming: boolean;
  filterable: boolean;
  required: boolean;
  group?: string;
  sort_order: number;
  source: 'template' | 'custom';
  deprecated: boolean;
  added_in_version: number;
}

/** A field as written in a template JSON file — options are plain strings. */
export interface TemplateField {
  key: string;
  label: Translated;
  type: FieldType;
  unit?: string;
  min?: number;
  max?: number;
  options?: string[];
  variant_forming?: boolean;
  filterable?: boolean;
  required?: boolean;
  group?: string;
}

export interface StarterCategory {
  code: string;
  name: Translated;
  fulfilment?: Fulfilment;
  tracking?: Tracking;
  visible_field_keys?: string[];
  children?: StarterCategory[];
}

export interface BusinessTemplate {
  code: string;
  version: number;
  name: Translated;
  default_fulfilment: Fulfilment;
  default_tracking: Tracking;
  fields: TemplateField[];
  starter_categories: StarterCategory[];
}
