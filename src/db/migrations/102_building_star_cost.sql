-- Bina yenileme yıldız harcar: her bina 30 yıldız; harcama deftere 'stars' olarak yazılır.
ALTER TABLE currency_ledger MODIFY currency ENUM('coins','freeze_time','magic_wand','stars') NOT NULL;
UPDATE buildings SET required_stars = 30;
