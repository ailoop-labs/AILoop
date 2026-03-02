export const AUTO_GENERATED_ADMIN_TOKEN_VALIDITY_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseUtcDayStart(dateString: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    return null;
  }

  const utcTime = Date.parse(`${dateString}T00:00:00.000Z`);
  return Number.isNaN(utcTime) ? null : utcTime;
}

function toUtcDayStart(now: Date): number {
  const utcDay = now.toISOString().slice(0, 10);
  return Date.parse(`${utcDay}T00:00:00.000Z`);
}

export function isDateBasedAdminTokenExpired(params: {
  tokenAuthEnabled: boolean;
  adminTokenIssuedDate: string;
  now?: Date;
  validityDays?: number;
}): boolean {
  const { tokenAuthEnabled, adminTokenIssuedDate, now = new Date(), validityDays = AUTO_GENERATED_ADMIN_TOKEN_VALIDITY_DAYS } =
    params;

  if (!tokenAuthEnabled || !adminTokenIssuedDate) {
    return false;
  }

  const issuedAtUtcDayStart = parseUtcDayStart(adminTokenIssuedDate);
  if (issuedAtUtcDayStart === null) {
    return true;
  }

  const elapsedDays = Math.floor((toUtcDayStart(now) - issuedAtUtcDayStart) / MS_PER_DAY);
  if (elapsedDays < 0) {
    return false;
  }

  return elapsedDays >= validityDays;
}
