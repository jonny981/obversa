import { expectTypeOf, test } from 'vitest';

import type {
  CachedProofPacket,
  ProofCache,
  ProofCacheCurrentBinding,
  ProofCacheOptions,
  ProofJob,
  ProofPacket,
  ProofPacketSource,
  ProofSource,
} from '@obversa/api';
import type {
  CachedProofPacket as RuntimeCachedProofPacket,
  ProofCache as RuntimeProofCache,
  ProofCacheCurrentBinding as RuntimeProofCacheCurrentBinding,
  ProofCacheOptions as RuntimeProofCacheOptions,
  ProofJob as RuntimeProofJob,
  ProofPacket as RuntimeProofPacket,
  ProofPacketSource as RuntimeProofPacketSource,
  ProofSource as RuntimeProofSource,
} from '../src/proof/cache.js';

test('proof-cache contracts are available from the API package', () => {
  expectTypeOf<CachedProofPacket>().toEqualTypeOf<RuntimeCachedProofPacket>();
  expectTypeOf<ProofCache>().toEqualTypeOf<RuntimeProofCache>();
  expectTypeOf<ProofCacheCurrentBinding>().toEqualTypeOf<RuntimeProofCacheCurrentBinding>();
  expectTypeOf<ProofCacheOptions>().toEqualTypeOf<RuntimeProofCacheOptions>();
  expectTypeOf<ProofJob>().toEqualTypeOf<RuntimeProofJob>();
  expectTypeOf<ProofPacket>().toEqualTypeOf<RuntimeProofPacket>();
  expectTypeOf<ProofPacketSource>().toEqualTypeOf<RuntimeProofPacketSource>();
  expectTypeOf<ProofSource>().toEqualTypeOf<RuntimeProofSource>();
});
