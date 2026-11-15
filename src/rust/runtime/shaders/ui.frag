#version 450
#extension GL_GOOGLE_include_directive : require
// Volatile keeps NVK off the incoherent constant load path.
#define STORAGE_ACCESS readonly volatile
#include "storage.glsl"
layout(location = 0) flat in uvec4 rect;
layout(location = 1) flat in uvec4 info;
layout(location = 2) flat in uint item;
layout(location = 3) flat in uvec2 page;
layout(location = 4) flat in vec2 toDisplay;
layout(location = 0) out vec4 color;
uvec2 sourceSize() {
  if (info.x == 1u && (info.z & 65535u) != 0u)
    return uvec2(info.z & 65535u, info.w);
  return rect.zw;
}
vec4 bitmapAt(ivec2 point) {
  uvec2 size = sourceSize();
  uvec2 q = uvec2(clamp(point, ivec2(0), ivec2(size) - 1));
  uint pixel = q.y * size.x + q.x;
  if (info.x == 5u)
    return rgba(word(info.y + pixel));
  if (info.x == 1u)
    return rgba(word(page.x + 1024u + info.y / 4u + pixel));
  uint offset = info.y + pixel;
  uint packed = word(page.x + 1024u + offset / 4u);
  return vec4(1, 1, 1, float((packed >> ((offset & 3u) * 8u)) & 255u) / 255.0);
}
vec4 premultiplied(vec4 value) {
  return vec4(value.rgb * value.a, value.a);
}
float lanczos2(float x) {
  x = abs(x);
  if (x < 1e-4)
    return 1.0;
  if (x >= 2.0)
    return 0.0;
  float px = 3.14159265 * x;
  return 2.0 * sin(px) * sin(px * 0.5) / (px * px);
}
// Four by four taps, each clamped to the source by bitmapAt, kept inside the range of the
// centre 2x2 so text and covers get no halos.
vec4 lanczosSample(vec2 q) {
  ivec2 low = ivec2(floor(q));
  vec2 f = fract(q);
  float wx[4], wy[4];
  float sumX = 0.0, sumY = 0.0;
  for (int i = 0; i < 4; i++) {
    wx[i] = lanczos2(f.x - float(i - 1));
    wy[i] = lanczos2(f.y - float(i - 1));
    sumX += wx[i];
    sumY += wy[i];
  }
  vec4 sum = vec4(0.0), lo = vec4(1e9), hi = vec4(-1e9);
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      vec4 tap = premultiplied(bitmapAt(low + ivec2(x - 1, y - 1)));
      sum += tap * (wx[x] / sumX) * (wy[y] / sumY);
      if (x == 1 || x == 2) {
        if (y == 1 || y == 2) {
          lo = min(lo, tap);
          hi = max(hi, tap);
        }
      }
    }
  }
  vec4 value = clamp(sum, lo, hi);
  if (value.a > 0.0)
    value.rgb /= value.a;
  return value;
}
vec4 bitmapSample(vec2 p) {
  vec2 scale = vec2(sourceSize()) / vec2(rect.zw);
  if (toDisplay == vec2(1.0) && scale == vec2(1.0))
    return bitmapAt(ivec2(p) - ivec2(rect.xy));
  uint filterMode = page.y;
  if (filterMode == 1u)
    return bitmapAt(ivec2(floor((p - vec2(rect.xy)) * scale)));
  vec2 q = (p - vec2(rect.xy)) * scale - 0.5;
  if (filterMode == 3u)
    return lanczosSample(q);
  ivec2 low = ivec2(floor(q));
  vec2 f = fract(q);
  vec4 top = mix(premultiplied(bitmapAt(low)),
                 premultiplied(bitmapAt(low + ivec2(1, 0))), f.x);
  vec4 bottom = mix(premultiplied(bitmapAt(low + ivec2(0, 1))),
                    premultiplied(bitmapAt(low + ivec2(1, 1))), f.x);
  vec4 value = mix(top, bottom, f.y);
  if (value.a > 0.0)
    value.rgb /= value.a;
  return value;
}
float roundedBox(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - halfSize + radius;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - radius;
}
float shapeDistance(vec2 p) {
  vec2 reach = vec2(rect.zw) * 0.5;
  return roundedBox(p - vec2(rect.xy) - reach, reach, float(info.z & 255u));
}
vec4 over(vec4 top, vec4 bottom) {
  float alpha = top.a + bottom.a * (1.0 - top.a);
  vec3 rgb = top.rgb * top.a + bottom.rgb * bottom.a * (1.0 - top.a);
  return alpha > 0.0 ? vec4(rgb / alpha, alpha) : vec4(0);
}
void main() {
  vec2 p = gl_FragCoord.xy * toDisplay;
  if (info.x == 0u) {
    color = rgba(info.z);
  } else if (info.x == 1u || info.x == 2u) {
    vec4 sampled = bitmapSample(p);
    color = info.x == 1u ? sampled : vec4(rgba(info.z).rgb, rgba(info.z).a * sampled.a);
    if (info.x == 1u && (info.z >> 16u) != 0u) {
      vec2 reach = vec2(rect.zw) * 0.5;
      float inside = roundedBox(p - vec2(rect.xy) - reach, reach, float(info.z >> 16u));
      color.a *= 1.0 - smoothstep(-1.0, 0.0, inside);
    }
  } else if (info.x == 6u) {
    float distance = shapeDistance(p);
    float width = float((info.z >> 8u) & 255u);
    color = vec4(rgba(info.y).rgb, rgba(info.y).a * (1.0 - smoothstep(-1.0, 0.0, distance)));
    if (width > 0.0) {
      float line = 1.0 - smoothstep(0.0, 1.0, abs(distance + width * 0.5) - width * 0.5);
      if ((info.z & 65536u) != 0u && mod(p.x + p.y, 24.0) > 14.0)
        line = 0.0;
      vec4 stroke = rgba(info.w);
      color = over(vec4(stroke.rgb, stroke.a * line), color);
    }
  } else if (info.x == 3u) {
    vec2 center = vec2(rect.xy) + vec2(rect.zw) * 0.5;
    color = vec4(0);
    if ((info.z & 2u) != 0u) {
      float distance = length(p - vec2(float(rect.x) - 14.0, center.y)) - 4.0;
      color = vec4(0.45, 0.95, 0.60, 1.0 - smoothstep(-0.8, 0.8, distance));
    }
    if (info.y != 0u) {
      bool pending =
          (word(CMD_SEQUENCE) != 0u && word(CMD_SEQUENCE) != word(HOST_ACK) &&
           word(CMD_PAGE) == word(UI_APPLIED)) ||
          (info.z & 8u) != 0u;
      float pulse =
          pending ? 0.55 + 0.45 * sin(float(word(FRAME_COUNTER)) * 0.4) : 1.0;
      uint accent = word(page.x + 12u);
      vec3 ring = accent != 0u ? rgba(accent).rgb : vec3(0.25, 0.85, 0.90);
      float gap = 10.3;
      float distance = roundedBox(p - center, vec2(rect.zw) * 0.5 + gap, float(info.w) + gap);
      float line = 1.0 - smoothstep(3.0, 4.3, abs(distance));
      float glow = distance > 0.0 ? 0.4 * exp(-distance / 14.0) * (1.0 - smoothstep(14.0, 30.0, distance)) : 0.0;
      float alpha = pulse * max(line, glow * (1.0 - line));
      color = over(vec4(ring, alpha), color);
    }
  } else if (info.x == 5u) {
    color = bitmapSample(p);
  } else {
    vec2 d = p - (vec2(rect.xy) + vec2(rect.zw) * 0.5);
    float angle =
        mod(atan(d.y, d.x) - float(word(FRAME_COUNTER)) * 0.15, 6.28318530718);
    float alpha = (1.0 - smoothstep(2.0, 3.5, abs(length(d) - 18.0))) *
                  smoothstep(0.0, 0.6, angle) *
                  (1.0 - smoothstep(3.6, 4.4, angle));
    color = vec4(0.84, 0.91, 0.96, alpha);
  }
}
