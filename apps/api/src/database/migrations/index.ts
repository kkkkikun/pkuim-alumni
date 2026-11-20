import { BackfillVerificationHistory1730000003000 } from './1730000003000-BackfillVerificationHistory';
import { FixCreatedByForeignKey1730000002000 } from './1730000002000-FixCreatedByForeignKey';
import { FixVerifiedByForeignKey1730000001000 } from './1730000001000-FixVerifiedByForeignKey';
import { InitSchema1730000000000 } from './1730000000000-InitSchema';
import { WidenIdempotencyScope1730000004000 } from './1730000004000-WidenIdempotencyScope';
import { AddQueryIndexesAndProtectAuditLogs1730000005000 } from './1730000005000-AddQueryIndexesAndProtectAuditLogs';

/** 迁移清单：按时间戳顺序执行。 */
export const migrations = [
  InitSchema1730000000000,
  FixVerifiedByForeignKey1730000001000,
  FixCreatedByForeignKey1730000002000,
  BackfillVerificationHistory1730000003000,
  WidenIdempotencyScope1730000004000,
  AddQueryIndexesAndProtectAuditLogs1730000005000,
];

export default migrations;
