/** `EngineRegistry` over a fixed set of adapters (one per engine). */
import type { EngineAdapter, EngineRegistry } from '../../application/ports/engines.ts';
import { ENGINES, isEngine, type Engine } from '../../../shared/domain/engine.ts';
import { GalleryDlAdapter, type GalleryDlAdapterOptions } from './gallery-dl/gallery-dl-adapter.ts';
import { YtDlpAdapter } from './yt-dlp/yt-dlp-adapter.ts';

/** Weight for an engine name read from untrusted storage that is not a known engine. */
const UNKNOWN_ENGINE_WEIGHT = 1;

export class StaticEngineRegistry implements EngineRegistry {
  readonly #adapters: ReadonlyMap<Engine, EngineAdapter>;

  /** Throws when an engine is missing or registered twice (composition bug). */
  constructor(adapters: readonly EngineAdapter[]) {
    const map = new Map<Engine, EngineAdapter>();
    for (const adapter of adapters) {
      if (map.has(adapter.engine)) throw new Error(`Engine adapter registered twice: ${adapter.engine}`);
      map.set(adapter.engine, adapter);
    }
    const missing = ENGINES.filter((engine) => !map.has(engine));
    if (missing.length > 0) throw new Error(`Missing engine adapters: ${missing.join(', ')}`);
    this.#adapters = map;
  }

  get(engine: Engine): EngineAdapter {
    const adapter = this.#adapters.get(engine);
    if (!adapter) throw new Error(`Unknown engine: ${String(engine)}`);
    return adapter;
  }

  /** Slot weight for any stored engine name (unknown names weigh 1, like the legacy host). */
  slotWeightOf(engine: string): number {
    return isEngine(engine) ? this.get(engine).slotWeight : UNKNOWN_ENGINE_WEIGHT;
  }
}

export interface EngineRegistryOptions {
  readonly galleryDl?: GalleryDlAdapterOptions;
}

export function createEngineRegistry(options: EngineRegistryOptions = {}): StaticEngineRegistry {
  return new StaticEngineRegistry([new GalleryDlAdapter(options.galleryDl), new YtDlpAdapter()]);
}
