export function callbackDigits(original: string): string {
  const words: Record<string, string> = {
    zero: "0",
    oh: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
  };
  return original
    .toLowerCase()
    .replace(
      /\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g,
      (word) => words[word],
    )
    .replace(/\D/g, "");
}
export function hasSpokenValue(
  transcript: string,
  value: string,
  identifier = false,
): boolean {
  const words: Record<string, string> = {
    zero: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
    dash: "-",
    hyphen: "-",
  };
  const compact = (text: string) => {
    const lower = text.toLowerCase();
    return identifier
      ? lower
          .replace(
            /\b(zero|one|two|three|four|five|six|seven|eight|nine|dash|hyphen)\b/g,
            (word) => words[word],
          )
          .replace(/[\s,]/g, "")
      : lower.replace(/[^\p{L}\p{N}]/gu, "");
  };
  const expected = compact(value);
  return !!expected && compact(transcript).includes(expected);
}
// Repair an AI-added/removed hyphen only by using a literal identifier actually spoken.
// Never repair changed digits or a missing prefix.
export function capturedIdentifier(
  transcript: string,
  proposed: string,
): string | null {
  const candidates =
    transcript
      .match(/\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*\b/g)
      ?.filter((v) => /\d/.test(v)) ?? [];
  const matching = candidates.filter(
    (v) =>
      v.replaceAll("-", "").toLowerCase() ===
      proposed.replaceAll("-", "").toLowerCase(),
  );
  if (matching.length === 1) return matching[0];
  if (candidates.length) return null;
  return hasSpokenValue(transcript, proposed, true) ? proposed : null;
}
export function spelledName(transcript: string): string | null {
  const match = transcript.match(/\b[A-Za-z](?:[-\s]+[A-Za-z]){2,}\b/);
  if (!match) return null;
  const letters = match[0].replace(/[^A-Za-z]/g, "").toLowerCase();
  return letters[0].toUpperCase() + letters.slice(1);
}
export function fullNameAnswer(
  transcript: string,
): { firstName: string; lastName: string } | null {
  const answer = transcript
    .trim()
    .replace(/^(?:my name is|i am|i['’]m|it['’]s)\s+/i, "")
    .replace(/[.!]+$/, "")
    .trim();
  // Recover only a clear two-part answer to a name question; leave complex/uncertain answers for clarification.
  const match = answer.match(/^(\p{Lu}[\p{L}'’\-]+)\s+(\p{Lu}[\p{L}'’\-]+)$/u);
  if (
    !match ||
    /\b(?:Not|Sure|Unknown|Hello|Sorry|Printer|Computer|Broken)\b/i.test(answer)
  )
    return null;
  return { firstName: match[1], lastName: match[2] };
}
export function validateCallback(original: string): {
  original: string;
  e164: string | null;
  reason?: string;
} {
  if (!/^(?:\+?1[ .()-]*)?[0-9 .()+-]+$/.test(original.trim()))
    return {
      original,
      e164: null,
      reason: "Repeat the number using digits; do not include an extension.",
    };
  let digits = original.replace(/\D/g, "");
  if (digits.length === 7)
    return {
      original,
      e164: null,
      reason: "Ask for the three-digit area code.",
    };
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits))
    return {
      original,
      e164: null,
      reason:
        "Ask the caller to repeat the complete ten-digit callback number.",
    };
  return { original, e164: `+1${digits}` };
}
export function explicitYes(text: string): boolean {
  return (
    /^(?:yes|yeah|yep|correct|that(?:'s| is) correct|confirmed|go ahead|please submit|please create)(?:[\s,.!]|$)/i.test(
      text.trim(),
    ) &&
    !/\b(?:but|except|not|no|change|don't|actually|wrong|incorrect|wait)\b/i.test(
      text,
    )
  );
}

// Room numbers may be transcribed as words or digits; this never changes asset identifiers.
export function normalizeLocation(value: string): string {
  const digits: Record<string, string> = {
    zero: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
  };
  return value
    .toLowerCase()
    .replace(
      /\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/g,
      (word) => digits[word],
    )
    .replace(/[^\p{L}\p{N}]/gu, "");
}
