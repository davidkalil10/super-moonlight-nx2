#version 450
#extension GL_GOOGLE_include_directive : require
#include "storage.glsl"
layout(location = 0) flat in uvec4 rect;
layout(location = 1) flat in uvec4 info;
layout(location = 2) flat in uint item;
layout(location = 0) out vec4 color;
vec4 rgba(uint value) {
  return vec4(value & 255u, (value >> 8u) & 255u, (value >> 16u) & 255u,
              value >> 24u) /
         255.0;
}
// The pixel of a `rect` bitmap under UI point p, clamped where a scaled edge rounds outside it.
uvec2 texel(vec2 p, uvec4 rect) {
  ivec2 q = ivec2(p) - ivec2(rect.xy);
  return uvec2(clamp(q, ivec2(0), ivec2(rect.zw) - 1));
}
float roundedBox(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - halfSize + radius;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - radius;
}
void main() {
  uint base = pageBase();
  vec2 p = gl_FragCoord.xy * (DISPLAY_SIZE / targetSize());
  if (info.x == 0u) {
    color = rgba(info.z);
    if ((info.w & 1u) != 0u) {
      float alpha = 0.65 + color.a * 0.35;
      color = vec4(color.rgb * color.a / alpha, alpha);
    }
  } else if (info.x == 1u || info.x == 2u) {
    uvec2 q = texel(p, rect);
    uint pixel = q.y * rect.z + q.x;
    uint offset = info.y + pixel * (info.x == 1u ? 4u : 1u);
    uint packed = word(base + 1024u + offset / 4u);
    color = info.x == 1u ? rgba(packed) : rgba(info.z);
    if (info.x == 2u)
      color.a *= float((packed >> ((offset & 3u) * 8u)) & 255u) / 255.0;
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
      float distance = roundedBox(p - center, vec2(rect.zw) * 0.5 + 4.0, 8.0);
      float alpha = pulse * (1.0 - smoothstep(1.2, 2.8, abs(distance)));
      color = vec4(mix(color.rgb * color.a, vec3(0.25, 0.85, 0.90), alpha),
                   color.a + alpha * (1.0 - color.a));
      if (color.a > 0.0)
        color.rgb /= color.a;
    }
  } else if (info.x == 5u) {
    uvec2 q = texel(p, rect);
    color = rgba(word(BADGE_PIXELS + q.y * rect.z + q.x));
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
