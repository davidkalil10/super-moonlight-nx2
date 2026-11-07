cmake_minimum_required(VERSION 3.16)
project(moonlight_inspector C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

add_executable(nx2-modules
  libnx2/examples/modules/main.c
  libnx2/src/runtime/module.c
  libnx2/src/runtime/trampoline.c)
target_include_directories(nx2-modules PRIVATE libnx2/include libnx2/include/libnx2)
target_compile_options(nx2-modules PRIVATE -Wall -Wextra -Werror)
