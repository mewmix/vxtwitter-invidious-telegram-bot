import re
import os
from telegram.ext import Updater, CommandHandler, MessageHandler, Filters

from dotenv import load_dotenv

load_dotenv()

token = os.environ.get("TELEGRAM_TOKEN")


def strip_youtube_url(url):
    match = re.search(r"(?<=v=)[^&#]+", url)
    if match:
        video_id = match.group()
        invidious_url = f"https://y.com.sb/watch?v={video_id}"
        return invidious_url
    else:
        match = re.search(r"(?<=\.be/)[^&#]+", url)
        if match:
            video_id = match.group()
            invidious_url = f"https://y.com.sb/watch?v={video_id}"
            return invidious_url
    return None

def strip_twitter_url(url):
    match = re.search(r"https://twitter.com/([^/]+)/status/(\d+)", url)
    if match:
        username = match.group(1)
        tweet_id = match.group(2)
        vxtwitter_url = f"https://vxtwitter.com/{username}/status/{tweet_id}"
        return vxtwitter_url
    return None

def handle_message(update, context):
    message = update.message.text
    invidious_url = strip_youtube_url(message)
    username = update.message.from_user.username
    if invidious_url and context.bot.username.lower() in update.message.text.lower():
        update.message.reply_text(f'Here is an invidious url for @{username}: {invidious_url}')
        context.bot.delete_message(chat_id=update.effective_chat.id, message_id=update.message.message_id)


    else:
        twitter_url = strip_twitter_url(message)
        if twitter_url:
            username = update.message.from_user.username
            update.message.reply_text(f'Hi @{username}, your Twitter link is {twitter_url}.')
            context.bot.delete_message(chat_id=update.effective_chat.id, message_id=update.message.message_id)
         

def main():
    # Put your Telegram Bot API Token here
    updater = Updater(token, use_context=True)
    dp = updater.dispatcher
    # Add message handler
    dp.add_handler(MessageHandler(Filters.text, handle_message))
    updater.start_polling()
    updater.idle()

if __name__ == '__main__':
    main()