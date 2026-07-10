export interface ValidationResult {
  isValid: boolean;
  missingKeys: string[];
  extraKeys: string[];
  placeholderMismatches: string[];
}

/**
 * Compares a target translation file against the base (source of truth) for keys and placeholders.
 */
export function validateLocale(
  base: Record<string, string>,
  target: Record<string, string>
): ValidationResult {
  const missingKeys: string[] = [];
  const extraKeys: string[] = [];
  const placeholderMismatches: string[] = [];

  const baseKeys = Object.keys(base);
  const targetKeys = Object.keys(target);

  // Search for missing keys and check placeholder lists
  for (const key of baseKeys) {
    if (!(key in target)) {
      missingKeys.push(key);
    } else {
      const basePlaceholders = (base[key].match(/{[^}]+}/g) || []).sort();
      const targetPlaceholders = (target[key].match(/{[^}]+}/g) || []).sort();
      if (JSON.stringify(basePlaceholders) !== JSON.stringify(targetPlaceholders)) {
        placeholderMismatches.push(
          `Key "${key}": expected placeholders [${basePlaceholders.join(', ')}], found [${targetPlaceholders.join(', ')}]`
        );
      }
    }
  }

  // Search for redundant/unrecognized keys
  for (const key of targetKeys) {
    if (!(key in base)) {
      extraKeys.push(key);
    }
  }

  return {
    isValid: missingKeys.length === 0 && extraKeys.length === 0 && placeholderMismatches.length === 0,
    missingKeys,
    extraKeys,
    placeholderMismatches,
  };
}
