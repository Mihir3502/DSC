// The header's active-hold slot (packet M3.2; UI_FLOW §10). It renders nothing
// without a hold, so a record looks the same as it will once holds exist. The
// meaning is in words, not color.

export function HoldIndicator({
  hold,
}: {
  hold: Readonly<{ label: string }> | null;
}) {
  if (!hold) return null;
  return (
    <p
      role="note"
      className="rounded-lg border-2 border-foreground p-3 font-medium"
    >
      On hold: {hold.label}
    </p>
  );
}
