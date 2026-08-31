# Obserwacje operacyjne

- Daktela ma duży, zaszumiony backlog. W tej samej kategorii występują realne pytania klientów,
  automatyczne potwierdzenia, powiadomienia płatnicze, wiadomości kurierskie i odbicia poczty.
- Jedno zgłoszenie może zmieniać intencję w czasie. Agent musi utrzymywać stan całej sprawy,
  a nie odpowiadać wyłącznie na ostatnią wiadomość.
- Discord BOK służy dziś do ręcznego przekazywania decyzji i wyjątków: płatności, zwrotów,
  ponownych wysyłek, reklamacji oraz eskalacji do magazynu i IT.
- Część kanałów jest historyczna. Kontekst należy ważyć datą i aktywnością, nie samą nazwą.
- Kanały mogą zawierać jawne sekrety. Nie wolno ich przenosić do pamięci agenta.
- `pomocnik-ML` jest dobrym wzorcem zachowania: pamięć decyzji, konkretne diagnozy, lista spraw,
  jawne blokady i eskalacje. Nie jest jednak agentem BOK i nie zastępuje pracy w Dakteli.
