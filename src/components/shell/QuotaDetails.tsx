import type { QuotaSnapshot } from "../../api/types";
import { freshness } from "../../lib/quota";
import { QuotaWindowRow } from "./QuotaWindowRow";

/** 侧栏与额度总览共用额度窗口、重置时间和实际额度数据的刷新时间。 */
export function QuotaDetails({ quota, now, account }: {
  quota: QuotaSnapshot | null | undefined;
  now: number;
  account?: string | null;
}) {
  const updatedAt = quota?.rate_limits_updated_at;
  const updatedTitle = typeof updatedAt === "number" && Number.isFinite(updatedAt)
    ? `额度刷新时间：${new Date(updatedAt * 1000).toLocaleString()}`
    : "尚未收到额度数据";
  return <div className="quota-details flex min-w-0 flex-col gap-1.5">
    <QuotaWindowRow label="5小时" win={quota?.five_hour} now={now} />
    <QuotaWindowRow label="周" win={quota?.seven_day} now={now} />
    <div className="quota-details-footer flex min-w-0 items-center justify-between gap-2 font-ui text-label-sm text-outline">
      <span className="min-w-0 truncate" title={account ?? undefined}>{account ?? "未读取到账号"}</span>
      <span className="shrink-0" title={updatedTitle}>数据 {freshness(updatedAt, now)}</span>
    </div>
  </div>;
}
