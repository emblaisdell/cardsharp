# Money Money Money

Money Money Money is a turn-based standard deck card game.

Players each maintain private hands and a face down deck of cards that no one can look at called their "money pile"

Players start their turn drawing cards:
- 2 cards for a hand <=5 cards
- 1 card for a hand >5 and <=15 cards
- 0 cards for a hand >15 cards

Players then play as many melds as they want on their turn.  A trick is a book (same value different suit) or a run (same suit, contiguous values, wrapping at ace).  Note that QKA23 of a suit is a valid run of length 5.  Individual cards also trivially are melds of size 1.

Melds of size 1 are privately placed on the player's money pile.

Melds of size n>=2 are displayed to all players and placed face down on that players money pile.  Then n*(n-1) extra bonus cards are taken from the draw deck to the player's money pile without any player looking at them.

Then a player indicates they are done, play passes to the next player.

Players can randomly shuffle their own money piles at any time.

Players start with 5 cards each in their hands and the rest start in the draw deck.

Once the draw deck is gone, or would be after a draw or bonus, you replenish.  Say m is the minimal number of cards in a player's money pile.  Each player contributes m cards from the top of their money pile to the center.  These, plus the (very small) remainder of the original deck, are shuffled and become the new draw deck.  Players with zero cards in their money pile during a replenish are eliminated.

The last player to be eliminated wins.