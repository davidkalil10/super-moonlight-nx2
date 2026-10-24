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
  src/main.c src/status.c src/video.c src/audio.c src/input.c)
target_compile_options(hbmoonlight PRIVATE -Wall -Wextra -Wno-unused-parameter)
target_link_libraries(hbmoonlight PRIVATE gamestream Threads::Threads)
