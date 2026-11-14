#version 450
#extension GL_GOOGLE_include_directive : require
#define main original_main
#include "ui-base.frag"
#undef main

void main() {
  if (info.x == 2u) {
    vec2 p = gl_FragCoord.xy * toDisplay;
    float alpha = bitmapSample(p).a;
    vec4 ink = rgba(info.z);
    color = vec4(ink.rgb, ink.a * alpha);
  } else {
    original_main();
  }
}
