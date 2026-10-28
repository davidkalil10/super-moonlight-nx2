cmake_minimum_required(VERSION 3.16)
project(hbmoonlight C)

set(CMAKE_C_STANDARD 11)
set(UPSTREAM_DIR "" CACHE PATH "Directory filled by fetch.sh")
if(NOT EXISTS "${UPSTREAM_DIR}/moonlight-embedded/libgamestream/client.c")
  message(FATAL_ERROR "Run fetch.sh and pass -DUPSTREAM_DIR=<dest>")
endif()

set(BUILD_SHARED_LIBS OFF)
add_subdirectory(${UPSTREAM_DIR}/moonlight-common-c common-c)

find_package(PkgConfig REQUIRED)
find_package(Threads REQUIRED)
pkg_check_modules(DEPS REQUIRED IMPORTED_TARGET
  libavcodec libavutil libswscale opus libcurl expat uuid openssl)

set(GAMESTREAM ${UPSTREAM_DIR}/moonlight-embedded/libgamestream)
add_library(gamestream STATIC
  ${GAMESTREAM}/client.c ${GAMESTREAM}/http.c ${GAMESTREAM}/mkcert.c ${GAMESTREAM}/xml.c)
target_include_directories(gamestream PUBLIC
  ${GAMESTREAM} ${UPSTREAM_DIR}/moonlight-common-c/src)
target_link_libraries(gamestream PUBLIC moonlight-common-c PkgConfig::DEPS)

add_executable(hbmoonlight
  src/main.c src/session.c src/video.c src/audio.c src/input.c)
target_compile_options(hbmoonlight PRIVATE -Wall -Wextra -Wno-unused-parameter)
target_link_libraries(hbmoonlight PRIVATE gamestream Threads::Threads)

# The input test lives in tests/: it builds when that directory is there, or where
# DEV_DIR points.
set(DEV_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../tests/tools/moonlight/helper"
  CACHE PATH "tests helper directory")
set(HAVE_DEV EXISTS "${DEV_DIR}/tests/input.c")

include(CTest)
if(BUILD_TESTING AND ${HAVE_DEV})
  add_executable(hbmoonlight-input-check ${DEV_DIR}/tests/input.c src/input.c)
  target_include_directories(hbmoonlight-input-check PRIVATE src ${UPSTREAM_DIR}/moonlight-common-c/src)
  target_compile_options(hbmoonlight-input-check PRIVATE -Wall -Wextra -Wno-unused-parameter -UNDEBUG)
  add_test(NAME input-routing COMMAND hbmoonlight-input-check)
endif()
