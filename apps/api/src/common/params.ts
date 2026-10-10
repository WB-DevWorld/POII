import { Id } from '@poii/contracts';

/** Route ids are UUIDs; anything else is a 400 validation failure. */
export const parseId = (value: string): string => Id.parse(value);
