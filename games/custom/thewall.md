# The Wall

The Wall is a standard deck card game where each suit does what it looks like.

## Resource Cards

Red cards are resource cards.

Diamonds are valuable, they determine who wins at the end.

Hearts are the health of your wall (they are the wall); the wall protects your diamonds (as described later).

## Attack Cards

Spades dig under the wall, stealing some diamonds.

Clubs attack the wall directly, dealing damage to the wall.  If there is no wall when the club is played, all diamonds go to the attacker.

In summary, spades attack diamonds which go to the attacker, clubs attack hearts which go to the discard.

## Card Value

Every card has a numerical value.  It's the number for number cards, 10 for face cards and 11 (not 1) for aces.

## No Change Rule

The attack card has a numerical value, and the defender must give away a set of cards (of the appropriate suit, diamonds for spades and hearts for diamonds) that _sum_ to at least the value of the attack card.  This choice of set of cards is up to the defender.  If the sum of all of the defender's card of the appropriate suit is less than the attack value, the defender must give all of there cards.  There is no overflow (in particular a club overflow doesn't take any diamonds)

## Logistics

This game is turn based with turns always proceeding in the same order.

Players start with 7 card private hands and draw 2 cards at the start of each turn.

Players can play 0-3 (inclusive) cards each turn, and must end the turn with <=7 cards in their hand.  Playing resource cards puts them in front of you (in the appropriate stack) and playing attack cards targets another player of the attacker's choice.

Once the draw deck is gone, players no longer draw at the start of the turn and must play at least one card from their hand on their turn (the last player to draw may draw only one card if there is only one left).  If you have no cards in your hand at the start of your turn, you are skipped in this phase.

The game is over when the draw deck is gone there are no players have cards left in their hands.  The winner is the player with the largest sum of diamonds.



