export function matchRealtimeOutputIdentity(
  left: { itemId?: string; responseId?: string },
  right: { itemId?: string; responseId?: string },
): "same" | "different" | "unknown" {
  const responseComparable = Boolean(left.responseId && right.responseId);
  if (responseComparable && left.responseId !== right.responseId) {
    return "different";
  }
  const itemComparable = Boolean(left.itemId && right.itemId);
  if (itemComparable && left.itemId !== right.itemId) {
    return "different";
  }
  const bothEmpty = !left.responseId && !left.itemId && !right.responseId && !right.itemId;
  return responseComparable || itemComparable || bothEmpty ? "same" : "unknown";
}
