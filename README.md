
# vxtwitter-invidious-telegram-bot


## Install :

```
git clone https://github.com/mewmix/vxtwitter-invidious-telegram-bot.git
````
Navigate to the cloned directory:


```
cd vxtwitter-invidious-telegram-bot
```
Install the required Python packages:

```
pip install -r requirements.txt
```
Create a new bot in Telegram and obtain the bot token. For instructions on how to do this, see Telegram's [bot father](https://t.me/botfather).

Create a new .env file in the project directory and add the following line:

```
TELEGRAM_TOKEN=your_bot_token_here
```
Replace your_bot_token_here with the bot token obtained in step 4.

Run the bot:

```
python bot.py
```
That's it! You should now be able to use the bot to convert YouTube and Twitter links to alternative URLs in your Telegram conversations. 

To trigger the url conversion just tag the bot in conversation. For twitter links they will be automatically handled and the original message will be deleted after being processed. The user that sent the message will be tagged upon its completion.



If you encounter any issues, please refer to the project's Github page for further information or contact me on [telegram](https://t.me/s/ze_rg).

### Permissions
Talk to [bot father](https://t.me/botfather) - make sure Group Privacy is Off & The Bot Requests Delete Posts in Admin Rights

<img width="282" alt="Screen Shot 2023-03-14 at 11 10 56 PM" src="https://user-images.githubusercontent.com/42463809/225224122-d087f9e0-e8f8-4ebe-9eb3-7af11b54a5f0.png">

<img width="340" alt="Screen Shot 2023-03-14 at 11 11 03 PM" src="https://user-images.githubusercontent.com/42463809/225224120-3334e30e-a0c7-406c-bef6-7186c2731bc4.png">

<img width="425" alt="Screen Shot 2023-03-14 at 11 11 11 PM" src="https://user-images.githubusercontent.com/42463809/225224118-eaad0628-b9e1-49b9-9741-113bbdbdafcd.png">
