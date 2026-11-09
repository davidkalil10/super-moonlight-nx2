// SPDX-License-Identifier: ISC
/**
 * @file types.h
 * @brief Basic integer types, handles and compiler helpers, as in libnx.
 * @author Azkali Manad
 * @copyright libnx2 Authors
 */
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdalign.h>

#ifndef SSIZE_MAX
#ifdef SIZE_MAX
#define SSIZE_MAX ((SIZE_MAX) >> 1)
#endif
#endif

typedef uint8_t  u8;       ///< 8-bit unsigned integer.
typedef uint16_t u16;      ///< 16-bit unsigned integer.
typedef uint32_t u32;      ///< 32-bit unsigned integer.
typedef uint64_t u64;      ///< 64-bit unsigned integer.
typedef __uint128_t u128;  ///< 128-bit unsigned integer.

typedef int8_t  s8;        ///< 8-bit signed integer.
typedef int16_t s16;       ///< 16-bit signed integer.
typedef int32_t s32;       ///< 32-bit signed integer.
typedef int64_t s64;       ///< 64-bit signed integer.
typedef __int128_t s128;   ///< 128-bit signed integer.

typedef volatile u8   vu8;   ///< 8-bit volatile unsigned integer.
typedef volatile u16  vu16;  ///< 16-bit volatile unsigned integer.
typedef volatile u32  vu32;  ///< 32-bit volatile unsigned integer.
typedef volatile u64  vu64;  ///< 64-bit volatile unsigned integer.
typedef volatile u128 vu128; ///< 128-bit volatile unsigned integer.

typedef volatile s8   vs8;   ///< 8-bit volatile signed integer.
typedef volatile s16  vs16;  ///< 16-bit volatile signed integer.
typedef volatile s32  vs32;  ///< 32-bit volatile signed integer.
typedef volatile s64  vs64;  ///< 64-bit volatile signed integer.
typedef volatile s128 vs128; ///< 128-bit volatile signed integer.

typedef u32 Handle;                 ///< Kernel object handle.
typedef u32 Result;                 ///< Result code returned by most functions.
typedef void (*ThreadFunc)(void*);  ///< Thread entry point.
typedef void (*VoidFn)(void);       ///< Function with no arguments and no return value.

/// 16-byte unique identifier.
typedef struct Uuid {
    u8 uuid[0x10]; ///< Raw bytes.
} Uuid;

/// Three floats.
typedef struct UtilFloat3 {
    float value[3]; ///< Components.
} UtilFloat3;

/// Bitmask with bit n set.
#ifndef BIT
#define BIT(n) (1U << (n))
#endif

/// 64-bit bitmask with bit n set.
#ifndef BITL
#define BITL(n) (1UL << (n))
#endif

/// Struct without padding between members.
#ifndef NX_PACKED
#define NX_PACKED __attribute__((packed))
#endif

/// Function that never returns.
#ifndef NX_NORETURN
#define NX_NORETURN __attribute__((noreturn))
#endif

/// Marks an argument as used, to silence unused-parameter warnings.
#ifndef NX_IGNORE_ARG
#define NX_IGNORE_ARG(x) (void)(x)
#endif

/// Deprecated function; define LIBNX_NO_DEPRECATION to silence it.
#ifndef NX_DEPRECATED
#ifndef LIBNX_NO_DEPRECATION
#define NX_DEPRECATED __attribute__((deprecated))
#else
#define NX_DEPRECATED
#endif
#endif

/// Header function, always inlined.
#define NX_INLINE __attribute__((always_inline)) static inline

/// Header function, constexpr in C++14 and later, \ref NX_INLINE otherwise.
#if __cplusplus >= 201402L
#define NX_CONSTEXPR NX_INLINE constexpr
#else
#define NX_CONSTEXPR NX_INLINE
#endif

/// Invalid handle.
#define INVALID_HANDLE ((Handle)0)
