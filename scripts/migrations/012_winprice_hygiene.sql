-- Čištění vadných dat ve win_prices (import z Registru smluv obsahoval nesmyslná
-- data podpisu: 0001-01-01 i budoucí roky do 2027). Datum mimo rozsah
-- [2015-01-01, dnešek] je nedůvěryhodné → NULL. Cena a předmět zůstávají —
-- mají hodnotu pro cenová pásma, zahazuje se jen nespolehlivé datum.
-- Nové importy stejná data filtrují už při parsování (fetch-win-prices.ts).
UPDATE win_prices
SET datum = NULL
WHERE datum < DATE '2015-01-01' OR datum > CURRENT_DATE;
