function maskSensitiveText(value) {
  let matches = 0;
  const maskDigits = (match) => {
    matches += 1;
    const digits = match.replace(/\D/g, "");
    return `••••${digits.slice(-4)}`;
  };
  const masked = String(value || "")
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, maskDigits)
    .replace(/\b\d{9,12}\b/g, maskDigits)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, () => {
      matches += 1;
      return "[EMAIL REDACTED]";
    })
    .replace(/\b(?:password|passwd|secret|token|api[_ -]?key)\s*[:=]\s*\S+/gi, (match) => {
      matches += 1;
      return match.replace(/[:=]\s*\S+$/, ": [REDACTED]");
    });
  return { masked, count: matches };
}

module.exports = { maskSensitiveText };
