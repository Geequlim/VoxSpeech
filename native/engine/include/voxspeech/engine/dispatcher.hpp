#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace voxspeech::engine {

enum class DispatchError : std::int32_t {
	none = 0,
	parse_error = -32700,
	invalid_request = -32600,
	method_not_found = -32601,
	invalid_params = -32602,
	protocol_version_mismatch = -32001,
};

struct DispatchResult {
	DispatchError error{DispatchError::none};
	std::string id;
	std::string method;
	std::string details;

	[[nodiscard]] explicit operator bool() const noexcept
	{
		return error == DispatchError::none;
	}
};

[[nodiscard]] DispatchResult validateRequest(std::string_view json);

} // namespace voxspeech::engine
