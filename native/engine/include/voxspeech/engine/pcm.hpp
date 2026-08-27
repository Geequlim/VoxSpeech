#pragma once

#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace voxspeech::engine {

// Clamps each sample to [-1, 1] and converts it to signed little-endian PCM16
// via lrint(sample * 32767). NaN samples are treated as silence.
[[nodiscard]] std::vector<std::uint8_t> floatsToPcm16Le(std::span<const float> samples);

// Canonical RFC 4648 Base64 with padding and no whitespace.
[[nodiscard]] std::string base64Encode(std::span<const std::uint8_t> bytes);

// Decodes canonical RFC 4648 Base64; returns false on any non-canonical input.
[[nodiscard]] bool base64Decode(std::string_view text, std::vector<std::uint8_t>& out);

} // namespace voxspeech::engine
