#version 450
#extension GL_GOOGLE_include_directive : require
#define main original_main
#include "ui-base.frag"
#undef main

void main() {
  if (info.x == 2u) {
    vec2 p = gl_FragCoord.xy * (DISPLAY_SIZE / targetSize());
    float alpha = bitmapSample(p).a;
    color = vec4(vec3(alpha), 1.0);
  } else {
    original_main();
  }
}
