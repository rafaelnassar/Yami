/** OS "reduce motion" preference (via framer-motion, which also honors it globally). */
import { useReducedMotion as useFramerReducedMotion } from 'framer-motion';

export function useReducedMotion(): boolean {
  return Boolean(useFramerReducedMotion());
}
