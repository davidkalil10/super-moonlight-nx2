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
  src/main.c src/session.c src/status.c src/mailbox.c src/video.c src/audio.c src/input.c)
target_compile_options(hbmoonlight PRIVATE -Wall -Wextra -Wno-unused-parameter)
target_link_libraries(hbmoonlight PRIVATE gamestream Threads::Threads)

add_executable(hbmoonlight-bench src/bench.c src/status.c src/mailbox.c src/video.c)
target_compile_options(hbmoonlight-bench PRIVATE -Wall -Wextra -Wno-unused-parameter)
target_link_libraries(hbmoonlight-bench PRIVATE gamestream Threads::Threads)

# HBV2 encoder: tools/moonlight/hbv2enc.c built as is, and linked in process
# through src/encoder.c, with the flags of build-hbv2enc.sh.
find_package(OpenMP REQUIRED)
set(HBV2_FLAGS -O3 -march=native)
add_executable(hbv2enc ../hbv2enc.c)
target_compile_options(hbv2enc PRIVATE ${HBV2_FLAGS} -Wall -Wextra)
target_link_libraries(hbv2enc PRIVATE OpenMP::OpenMP_C m)

add_library(hbv2 STATIC src/encoder.c)
target_compile_options(hbv2 PRIVATE ${HBV2_FLAGS} -Wall -Wextra -Wno-unused-function)
target_link_libraries(hbv2 PUBLIC OpenMP::OpenMP_C m Threads::Threads)

add_executable(hbv2-encode-check src/encode-check.c)
target_compile_options(hbv2-encode-check PRIVATE -Wall -Wextra)
target_link_libraries(hbv2-encode-check PRIVATE hbv2)
