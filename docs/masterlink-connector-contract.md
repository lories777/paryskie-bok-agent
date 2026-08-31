# Kontrakt connectora MasterLink

Connector jest narzędziem pracownika BOK, nie osobnym chatbotem. Preferowany transport to lokalny
MCP `stdio` dostępny dla Codexa uruchomionego na tym samym VPS-ie. Alternatywnie może działać po
HTTP wyłącznie na `127.0.0.1`, z tokenem przechowywanym poza repozytorium w pliku `0600`.

## Odczyt

Minimalny zestaw narzędzi:

- `ml_get_order(order_number)`
- `ml_search_orders(email?, phone?, tracking_number?, external_id?)`
- `ml_get_payment(order_number)`
- `ml_get_fulfillment(order_number)`
- `ml_get_shipments(order_number)`
- `ml_get_returns_and_refunds(order_number)`
- `ml_get_customer_order_history(customer_identifier)`
- `ml_query(question, identifiers)` dla nietypowych odczytów

Każdy wynik odczytu zwraca co najmniej:

```json
{
  "found": true,
  "market": "CZ",
  "facts": {},
  "source": "masterlink",
  "checked_at": "2026-08-26T12:00:00Z",
  "error": null
}
```

Brak rekordu (`NOT_FOUND`), brak pola i błąd techniczny muszą być trzema różnymi wynikami.
Connector nie może zgadywać ani zwracać danych osobowych, których agent nie potrzebuje do sprawy.

## Zapis

Nie wolno udostępniać surowego SQL, ogólnego `update` ani narzędzia przyjmującego dowolne pola.
Każda mutacja ma osobne, wąskie narzędzie, np.:

- `ml_transition_order_status`
- `ml_add_order_note`
- `ml_cancel_order`
- `ml_create_return`
- `ml_update_return_status`
- `ml_create_refund_request`
- `ml_update_shipment_operation`

Każde narzędzie zapisu musi przyjmować:

- jednoznaczny identyfikator obiektu;
- oczekiwany stan przed zmianą (`expected_before` lub wersję rekordu);
- dokładną zmianę i powód;
- `dry_run`;
- `idempotency_key`.

Przy `dry_run=true` connector waliduje przejście i zwraca przewidywany stan bez zapisu. Przy zapisie
zwraca `before`, `after`, czas, identyfikator audytu i wynik ponownego odczytu. Ponowienie tego samego
`idempotency_key` nie może wykonać mutacji drugi raz.

## Autonomiczny runtime

Odczyty i jednoznaczne, rutynowe operacje BOK są dostępne agentowi samodzielnie. Dla zapisu agent:

1. ustala intencję klienta i stan w MasterLinku;
2. wykonuje właściwe narzędzie z `dry_run=true`;
3. przy dozwolonym przejściu wykonuje je z `dry_run=false` i stabilnym `idempotency_key`;
4. ponownie odczytuje rekord i uznaje operację za wykonaną dopiero po zgodnej weryfikacji.

Agent pyta BOK tylko wtedy, gdy intencja jest niejednoznaczna, sytuacja stanowi wyjątek od zasad
albo operacja niesie istotne ryzyko. Nie używa komend zatwierdzających ani technicznych numerów zgód.
Konflikt, niepewny wynik zapisu albo brak weryfikacji blokuje automatyczne ponowienie tej samej operacji.

## Wymagania operacyjne

- Sekrety poza repozytorium; `.env.example` zawiera wyłącznie nazwy zmiennych.
- Log audytu nie przechowuje haseł, tokenów ani pełnych danych osobowych.
- Timeout, limity wyników i czytelne błędy.
- Test istniejącego i nieistniejącego zamówienia, `dry_run`, konfliktu stanu oraz idempotentnego retry.
- Komenda startowa, wpis MCP do konfiguracji Codexa i krótki healthcheck.
