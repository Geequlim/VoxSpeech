#include "voxspeech/engine/codec.hpp"

#include <ostream>

namespace voxspeech::engine {

NdjsonDecoder::NdjsonDecoder(const std::size_t maxMessageSize)
	: maxMessageSize_(maxMessageSize)
{
}

FrameBatch NdjsonDecoder::push(const std::string_view bytes)
{
	FrameBatch batch;
	if (failed_) {
		batch.error = FrameError::message_too_large;
		return batch;
	}

	buffer_.append(bytes);
	std::size_t start = 0;
	auto newline = buffer_.find('\n', start);
	while (newline != std::string::npos) {
		const auto length = newline - start;
		if (length > maxMessageSize_) {
			failed_ = true;
			batch.messages.clear();
			batch.error = FrameError::message_too_large;
			buffer_.clear();
			return batch;
		}
		batch.messages.emplace_back(buffer_.substr(start, length));
		start = newline + 1;
		newline = buffer_.find('\n', start);
	}

	if (start != 0) {
		buffer_.erase(0, start);
	}
	if (buffer_.size() > maxMessageSize_) {
		failed_ = true;
		batch.messages.clear();
		batch.error = FrameError::message_too_large;
		buffer_.clear();
	}
	return batch;
}

bool NdjsonDecoder::failed() const noexcept
{
	return failed_;
}

std::size_t NdjsonDecoder::bufferedSize() const noexcept
{
	return buffer_.size();
}

OutputChannels::OutputChannels(std::ostream& protocolOutput, std::ostream& logOutput)
	: protocolOutput_(protocolOutput), logOutput_(logOutput)
{
}

bool OutputChannels::writeProtocol(const std::string_view json)
{
	if (json.empty() || json.size() > protocol::max_message_size || json.contains('\n') || !json.starts_with('{') ||
		!json.ends_with('}')) {
		return false;
	}
	glz::generic syntaxProbe;
	if (glz::read_json(syntaxProbe, json)) {
		return false;
	}
	std::lock_guard lock{mutex_};
	protocolOutput_ << json << '\n';
	protocolOutput_.flush();
	return protocolOutput_.good();
}

void OutputChannels::writeLog(const std::string_view message)
{
	std::lock_guard lock{mutex_};
	logOutput_ << message << '\n';
	logOutput_.flush();
}

} // namespace voxspeech::engine
