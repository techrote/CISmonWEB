export function globMatch(pattern, value) {
  let p = 0;
  let v = 0;
  let star = -1;
  let match = 0;

  while (v < value.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === value[v])) {
      p += 1;
      v += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      p += 1;
      match = v;
    } else if (star !== -1) {
      p = star + 1;
      match += 1;
      v = match;
    } else {
      return false;
    }
  }

  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}
